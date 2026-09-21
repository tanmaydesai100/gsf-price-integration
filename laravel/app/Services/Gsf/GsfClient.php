<?php

namespace App\Services\Gsf;

use App\Services\Gsf\Exceptions\GsfAuthException;
use App\Services\Gsf\Exceptions\GsfBlockedException;
use App\Services\Gsf\Exceptions\GsfException;
use GuzzleHttp\Cookie\CookieJar;
use Illuminate\Http\Client\Response;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Transport + session management for GSF TradeHub.
 *
 * There is no OAuth and no bearer token on TradeHub. Authentication is a
 * NextAuth session COOKIE, valid for a rolling one-year window. So:
 *
 *   - we log in once, cache the cookie jar, and reuse it for every lookup
 *   - we only log in again when the jar is empty or a call returns 401
 *   - a 403 is DataDome, NOT an auth problem: we surface it and stop
 *
 * Everything this class does is read-only. It never touches basket, order,
 * checkout or payment endpoints.
 */
class GsfClient
{
    private ?CookieJar $jar = null;
    private ?string $accountNo = null;

    // ---------------------------------------------------------------- public

    /** Authenticated GET. Re-authenticates once on 401, then retries. */
    public function get(string $path, array $query = [], array $headers = []): Response
    {
        return $this->send('GET', $path, ['query' => $query], $headers);
    }

    /** Authenticated JSON POST. Only used for the read-only /vrm/api lookup. */
    public function postJson(string $path, array $body, array $headers = []): Response
    {
        return $this->send('POST', $path, ['json' => $body], $headers);
    }

    /** The trade account number, from the live session unless pinned in config. */
    public function accountNo(): string
    {
        if ($this->accountNo) {
            return $this->accountNo;
        }

        if ($pinned = config('gsf.account_no')) {
            return $this->accountNo = (string) $pinned;
        }

        $session = $this->get('/api/auth/session')->json();
        $no = data_get($session, 'user.customer.accountNo');

        if (! $no) {
            throw new GsfAuthException('Signed in but no customer.accountNo in the session payload.');
        }

        return $this->accountNo = (string) $no;
    }

    /** Diagnostics for the artisan command / health check. */
    public function sessionInfo(): array
    {
        $session = $this->get('/api/auth/session')->json();

        return [
            'email'     => data_get($session, 'user.email'),
            'accountNo' => data_get($session, 'user.customer.accountNo'),
            'customer'  => data_get($session, 'user.customer.name'),
            'branchId'  => data_get($session, 'user.customer.branchId'),
            'expires'   => data_get($session, 'expires'),
        ];
    }

    /** Drop the cached cookies — next call logs in again. */
    public function forgetSession(): void
    {
        Cache::forget(config('gsf.cache.cookies_key'));
        $this->jar = null;
        $this->accountNo = null;
    }

    // --------------------------------------------------------------- internal

    private function send(string $method, string $path, array $options, array $headers): Response
    {
        $response = $this->dispatch($method, $path, $options, $headers);

        if ($response->status() === 401) {
            // Session died. Log in once and replay the request exactly once.
            Log::info('gsf: 401 — re-authenticating');
            $this->forgetSession();
            $this->authenticate();

            $response = $this->dispatch($method, $path, $options, $headers);

            if ($response->status() === 401) {
                $this->alert('GSF session could not be re-established (401 after fresh login).');
                throw new GsfAuthException('Still 401 after re-authenticating. Check GSF_EMAIL / GSF_PASSWORD.');
            }
        }

        $this->guard($response, $path);

        return $response;
    }

    private function dispatch(string $method, string $path, array $options, array $headers): Response
    {
        $jar = $this->jar();

        $request = Http::withOptions([
                'cookies'         => $jar,
                'allow_redirects' => ['max' => 3],
            ])
            ->timeout(config('gsf.timeout'))
            ->withHeaders($this->browserHeaders() + $headers);

        $response = match ($method) {
            'GET'  => $request->get($this->url($path), $options['query'] ?? []),
            'POST' => $request->post($this->url($path), $options['json'] ?? []),
            default => throw new GsfException("Unsupported method {$method}"),
        };

        // Guzzle has updated the jar in place (including any refreshed
        // datadome cookie); persist it so the next request reuses it.
        $this->persistJar($jar);

        return $response;
    }

    private function guard(Response $response, string $path): void
    {
        if ($response->status() === 403) {
            $this->alert("GSF returned 403 on {$path} — DataDome / WAF block.");
            throw new GsfBlockedException(
                "403 from GSF on {$path}. This is an edge block, not an auth failure. ".
                'Do not retry in a loop — capture fresh cookies from a browser on this '.
                "server's egress IP, or raise it with GSF."
            );
        }

        if ($response->status() === 401) {
            throw new GsfAuthException("401 from GSF on {$path}.");
        }

        if ($response->failed()) {
            throw new GsfException("GSF returned HTTP {$response->status()} on {$path}.");
        }
    }

    // ------------------------------------------------------------------ auth

    private function jar(): CookieJar
    {
        if ($this->jar instanceof CookieJar) {
            return $this->jar;
        }

        if ($stored = $this->loadJar()) {
            return $this->jar = $stored;
        }

        $this->authenticate();

        return $this->jar;
    }

    /**
     * NextAuth credentials sign-in.
     *
     * A lock means ten concurrent quotes that all hit a dead session produce
     * ONE login, not ten. The others wait and pick up the fresh jar.
     */
    private function authenticate(): void
    {
        $lock = Cache::lock('gsf:login', 60);

        try {
            $lock->block(30);
        } catch (Throwable $e) {
            throw new GsfAuthException('Timed out waiting for another process to complete GSF login.');
        }

        try {
            // Someone else may have logged in while we waited.
            if ($stored = $this->loadJar()) {
                $this->jar = $stored;
                return;
            }

            $email    = config('gsf.email');
            $password = config('gsf.password');

            if (! $email || ! $password) {
                throw new GsfAuthException('GSF_EMAIL / GSF_PASSWORD are not configured.');
            }

            $jar = new CookieJar();

            $base = Http::withOptions(['cookies' => $jar])
                ->timeout(config('gsf.timeout'))
                ->withHeaders($this->browserHeaders());

            // 1. Warm up — the edge hands real browsers a datadome cookie here.
            $base->get($this->url('/'));

            // 2. CSRF token (NextAuth requires it on the credentials callback).
            $csrf = $base->get($this->url('/api/auth/csrf'));
            $this->guard($csrf, '/api/auth/csrf');
            $csrfToken = $csrf->json('csrfToken');

            if (! $csrfToken) {
                throw new GsfAuthException('No csrfToken returned by /api/auth/csrf.');
            }

            // 3. Sign in.
            $login = $base->asForm()
                ->withOptions(['allow_redirects' => false])
                ->post($this->url('/api/auth/callback/credentials'), [
                    'csrfToken'                  => $csrfToken,
                    'callbackUrl'                => $this->url('/'),
                    'json'                       => 'true',
                    config('gsf.user_field')     => $email,
                    'password'                   => $password,
                ]);

            $this->guard($login, '/api/auth/callback/credentials');

            // NextAuth signals a bad password with a redirect back to the
            // sign-in page carrying ?error=, not with a 4xx status.
            $location = $login->header('Location');
            if (str_contains(strtolower($location.$login->body()), 'error')) {
                $this->alert('GSF login was rejected — check the credentials and the user_field name.');
                throw new GsfAuthException(
                    'GSF rejected the login. If the credentials are right, the form field name is '.
                    'probably wrong — try GSF_USER_FIELD=username. Redirect was: '.$location
                );
            }

            $this->jar = $jar;
            $this->persistJar($jar);
            $this->accountNo = null;

            Log::info('gsf: signed in, cookie jar cached');
        } finally {
            optional($lock)->release();
        }
    }

    // ---------------------------------------------------------------- cookies

    private function loadJar(): ?CookieJar
    {
        $raw = Cache::get(config('gsf.cache.cookies_key'));

        if (! $raw) {
            return null;
        }

        try {
            $cookies = json_decode(Crypt::decryptString($raw), true);
        } catch (Throwable $e) {
            Log::warning('gsf: cached cookie jar could not be decrypted, discarding');
            return null;
        }

        if (! is_array($cookies) || $cookies === []) {
            return null;
        }

        return new CookieJar(false, $cookies);
    }

    private function persistJar(CookieJar $jar): void
    {
        $cookies = $jar->toArray();

        if ($cookies === []) {
            return;
        }

        Cache::put(
            config('gsf.cache.cookies_key'),
            Crypt::encryptString(json_encode($cookies)),
            config('gsf.cache.cookies_ttl')
        );
    }

    // ----------------------------------------------------------------- utils

    private function browserHeaders(): array
    {
        return [
            'User-Agent'      => config('gsf.user_agent'),
            'Accept'          => 'application/json, text/plain, */*',
            'Accept-Language' => 'en-GB,en;q=0.9',
            'Sec-Fetch-Site'  => 'same-origin',
            'Sec-Fetch-Mode'  => 'cors',
            'Sec-Fetch-Dest'  => 'empty',
            'Referer'         => rtrim(config('gsf.base_url'), '/').'/',
        ];
    }

    private function url(string $path): string
    {
        return rtrim(config('gsf.base_url'), '/').'/'.ltrim($path, '/');
    }

    private function alert(string $message): void
    {
        Log::error($message);
        // Wire this to your notification channel of choice, e.g.
        // Notification::route('mail', config('gsf.alert_email'))->notify(new GsfIntegrationDown($message));
    }
}
