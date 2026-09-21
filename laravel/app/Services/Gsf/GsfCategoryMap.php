<?php

namespace App\Services\Gsf;

use App\Services\Gsf\Exceptions\GsfException;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\File;

/**
 * Turns the category a user picks into the componentId the parts endpoint wants.
 *
 *   "Wipers"  ->  867
 *
 * The map is generated ONCE and stored as a flat JSON file:
 *
 *   php artisan gsf:categories --export
 *
 * A normal price lookup reads that file and never touches /api/menus. That
 * keeps every quote down to two HTTP calls and removes a 250KB dependency
 * from the hot path.
 *
 * Resolution order:
 *   1. the JSON file          (normal operation — no network)
 *   2. the cache              (if the file is missing)
 *   3. live /api/menus        (last resort; also what --export calls)
 *
 * The rule the export relies on, established during the investigation:
 *
 *   lastMenuNodeId (menu tree)  ==  componentId (parts call)
 */
class GsfCategoryMap
{
    private ?array $memo = null;

    public function __construct(private GsfClient $client) {}

    /** ['wipers' => 867, 'wiper motor' => 924, ...] */
    public function all(): array
    {
        if ($this->memo !== null) {
            return $this->memo;
        }

        if ($fromFile = $this->fromFile()) {
            return $this->memo = $fromFile;
        }

        return $this->memo = Cache::remember(
            config('gsf.cache.menus_key'),
            config('gsf.cache.menus_ttl'),
            fn () => $this->fromApi()
        );
    }

    public function componentId(string $category): int
    {
        $key = $this->key($category);
        $map = $this->all();

        if (isset($map[$key])) {
            return $map[$key];
        }

        throw new GsfException(sprintf(
            'Unknown GSF category "%s". Closest matches: %s. '.
            '(If the catalogue changed, run: php artisan gsf:categories --export)',
            $category,
            implode(', ', array_slice($this->suggest($category), 0, 8)) ?: 'none'
        ));
    }

    public function has(string $category): bool
    {
        return isset($this->all()[$this->key($category)]);
    }

    /** Fuzzy match — for error messages and for an admin category picker. */
    public function suggest(string $needle): array
    {
        $needle = $this->key($needle);

        return array_values(array_filter(
            array_keys($this->all()),
            fn ($caption) => $needle !== '' && str_contains($caption, $needle)
        ));
    }

    // ------------------------------------------------------------- generation

    /**
     * Fetch the live tree and write it to the category file.
     * Called by `php artisan gsf:categories --export`. Not on the hot path.
     *
     * @return int number of categories written
     */
    public function export(?string $path = null): int
    {
        $map  = $this->fromApi();
        $path = $path ?: config('gsf.categories_file');

        ksort($map);

        File::ensureDirectoryExists(dirname($path));
        File::put($path, json_encode([
            '_generated' => now()->toIso8601String(),
            '_source'    => rtrim(config('gsf.base_url'), '/').'/api/menus',
            '_note'      => 'key = lowercased GSF menu caption, value = componentId '.
                            '(lastMenuNodeId). Regenerate with: php artisan gsf:categories --export',
            'categories' => $map,
        ], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        $this->memo = $map;
        Cache::forget(config('gsf.cache.menus_key'));

        return count($map);
    }

    public function forget(): void
    {
        $this->memo = null;
        Cache::forget(config('gsf.cache.menus_key'));
    }

    // ---------------------------------------------------------------- sources

    private function fromFile(): ?array
    {
        $path = config('gsf.categories_file');

        if (! $path || ! File::exists($path)) {
            return null;
        }

        $decoded = json_decode(File::get($path), true);
        $map     = $decoded['categories'] ?? null;

        if (! is_array($map) || $map === []) {
            return null;
        }

        return array_map('intval', $map);
    }

    private function fromApi(): array
    {
        $tree = $this->client->get('/api/menus')->json();

        $map = [];
        $this->walk($tree['popularCategories'] ?? [], $map);
        $this->walk($tree['featured'] ?? [], $map);

        if ($map === []) {
            throw new GsfException('/api/menus returned no usable category nodes.');
        }

        return $map;
    }

    private function walk(mixed $node, array &$map): void
    {
        if (is_array($node) && ! isset($node['caption'])) {
            foreach ($node as $child) {
                $this->walk($child, $map);
            }
            return;
        }

        if (! is_array($node)) {
            return;
        }

        $caption     = trim((string) ($node['caption'] ?? ''));
        $componentId = (int) ($node['lastMenuNodeId'] ?? 0);

        // Only leaf nodes carry a non-zero lastMenuNodeId; parent groups are 0.
        // First write wins, so the canonical path is kept over duplicates
        // elsewhere in the tree (both "Wipers" entries map to 867 anyway).
        if ($caption !== '' && $componentId > 0) {
            $map[$this->key($caption)] ??= $componentId;
        }

        $this->walk($node['children'] ?? [], $map);
    }

    private function key(string $caption): string
    {
        return mb_strtolower(trim(preg_replace('/\s+/', ' ', $caption)));
    }
}
