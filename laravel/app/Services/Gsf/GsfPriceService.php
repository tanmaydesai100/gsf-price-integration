<?php

namespace App\Services\Gsf;

use Illuminate\Support\Facades\Cache;

/**
 * The public face of the integration.
 *
 *   app(GsfPriceService::class)->getPartPrice('P44PYN', 'Wipers', 'BOSCH');
 *
 * Read-only throughout: one optional vehicle lookup and one parts GET.
 */
class GsfPriceService
{
    /** Sooner is better. Anything not listed sorts last. */
    private const AVAILABILITY_RANK = [
        'Immediate'    => 0,   // on the shelf at our branch
        'HubTomorrow'  => 1,   // next day from a regional hub
        'Group72Hours' => 2,   // ~3 days from the wider group
    ];

    public function __construct(
        private GsfClient $client,
        private GsfCategoryMap $categories,
    ) {}

    /**
     * @param  string       $reg       e.g. "P44PYN"
     * @param  string       $category  e.g. "Wipers"
     * @param  string|null  $brand     e.g. "BOSCH" — preference, not a filter
     * @param  string|null  $fitment   "Front", "Rear", or null for both
     * @param  string|null  $prefer    "availability" (default) or "price"
     */
    public function getPartPrice(
        string $reg,
        string $category,
        ?string $brand = null,
        ?string $fitment = 'Front',
        ?string $prefer = null,
    ): array {
        $reg         = $this->normaliseReg($reg);
        $componentId = $this->categories->componentId($category);
        $payload     = $this->fetch($reg, $category, $componentId);

        return $this->select($payload, $brand, $fitment, $prefer ?? config('gsf.prefer'));
    }

    /** Every candidate for the vehicle — useful for an admin/debug screen. */
    public function listParts(string $reg, string $category, ?string $fitment = null): array
    {
        $reg     = $this->normaliseReg($reg);
        $payload = $this->fetch($reg, $category, $this->categories->componentId($category));
        $parts   = data_get($payload, 'partData.parts', []);

        if ($fitment) {
            $parts = array_values(array_filter($parts, fn ($p) => ($p['fitment'] ?? null) === $fitment));
        }

        return array_map(fn ($p) => [
            'sku'          => $p['sku'] ?? null,
            'brand'        => $p['brand'] ?? null,
            'description'  => $p['description'] ?? null,
            'fitment'      => $p['fitment'] ?? null,
            'fitmentGroup' => $p['groupedPartNumber'] ?? null,
            'tradePrice'   => $p['customerPrice'] ?? null,
            'rrp'          => $p['retailPrice'] ?? null,
            'availability' => $p['availability'] ?? null,
            'quality'      => $p['quality'] ?? null,
        ], $parts);
    }

    // --------------------------------------------------------------- fetching

    private function fetch(string $reg, string $category, int $componentId): array
    {
        $ttl = (int) config('gsf.cache.parts_ttl');
        $key = "gsf:parts:{$reg}:{$componentId}";

        $call = function () use ($reg, $category, $componentId) {
            // 1. Resolve the registration. In testing the vrm header alone was
            //    enough for vehicles already in the account's history, but that
            //    was never proven for a brand-new reg — so we always do this.
            //    Read-only lookup; failures here are not fatal.
            try {
                $this->client->postJson('/vrm/api', ['vrm' => $reg]);
            } catch (\Throwable $e) {
                report($e);
            }

            // 2. Parts, pricing and stock.
            return $this->client->get('/parts/api/parts', [
                'partType'    => $category,    // display label; must be present
                'componentId' => $componentId, // the actual selector
            ], [
                'customerAccount' => $this->client->accountNo(),
                'vrm'             => $reg,
                'Cache-Control'   => 'no-store',
            ])->json();
        };

        // NOTE: this payload contains STOCK LEVELS. Whatever you cache is stock
        // as of that moment. GSF_PARTS_TTL=0 disables caching entirely.
        return $ttl > 0 ? Cache::remember($key, $ttl, $call) : $call();
    }

    // -------------------------------------------------------------- selection

    private function select(array $payload, ?string $brand, ?string $fitment, string $prefer): array
    {
        $parts = data_get($payload, 'partData.parts', []);

        $rows = $fitment
            ? array_values(array_filter($parts, fn ($p) => ($p['fitment'] ?? null) === $fitment))
            : $parts;

        // A null customerPrice means GSF will not sell it to us at all.
        $priced  = array_filter($rows, fn ($p) => ($p['customerPrice'] ?? null) !== null);
        $inStock = array_values(array_filter($priced, fn ($p) => ($p['availability'] ?? null) !== 'OutOfStock'));

        $vehicle = $payload['vehicle'] ?? [];

        if ($inStock === []) {
            return [
                'found'        => false,
                'registration' => $vehicle['vrm'] ?? null,
                'category'     => $payload['partTypeDecoded'] ?? null,
                'reason'       => 'No priced, in-stock part for this vehicle and fitment.',
                'considered'   => count($rows),
                'needsReview'  => true,
                'reviewReason' => 'Nothing quotable was returned — check manually before pricing.',
            ];
        }

        // Distinct fitment groups = distinct physical SIZES. More than one and
        // the catalogue cannot tell us which fits: that is a human decision.
        $groups      = array_values(array_unique(array_map(fn ($p) => $p['groupedPartNumber'] ?? '', $inStock)));
        $needsReview = count($groups) > 1;

        $sorter = $this->sorter($prefer);
        usort($inStock, $sorter);

        $preferred = $brand
            ? array_values(array_filter($inStock, fn ($p) => strcasecmp($p['brand'] ?? '', $brand) === 0))
            : [];

        $chosen = $preferred[0] ?? $inStock[0];

        $alternatives = array_values(array_map(
            fn ($p) => [
                'sku'          => $p['sku'],
                'brand'        => $p['brand'] ?? null,
                'tradePrice'   => $p['customerPrice'],
                'availability' => $p['availability'] ?? null,
            ],
            array_filter(
                $inStock,
                fn ($p) => ($p['groupedPartNumber'] ?? '') === ($chosen['groupedPartNumber'] ?? '')
                        && $p['sku'] !== $chosen['sku']
            )
        ));

        return [
            'found'         => true,
            'registration'  => $vehicle['vrm'] ?? null,
            'vin'           => $vehicle['vin'] ?? null,
            'vehicle'       => trim(($vehicle['make'] ?? '').' '.($vehicle['model'] ?? '')) ?: null,
            'category'      => $payload['partTypeDecoded'] ?? null,
            'componentId'   => $chosen['componentId'] ?? null,

            'brand'         => $chosen['brand'] ?? null,
            'sku'           => $chosen['sku'] ?? null,
            'description'   => $chosen['description'] ?? null,

            'tradePrice'    => $chosen['customerPrice'] ?? null,   // our cost, EX-VAT
            'rrp'           => $chosen['retailPrice'] ?? null,
            'vatRate'       => $chosen['taxRate'] ?? null,

            'inStock'       => true,
            'availability'  => $chosen['availability'] ?? null,
            'stock'         => [
                'local'   => $chosen['localStock'] ?? null,
                'hub'     => $chosen['hubStock'] ?? null,
                'company' => $chosen['companyStock'] ?? null,
            ],

            'fitment'       => $chosen['fitment'] ?? null,
            'fitmentGroup'  => $chosen['groupedPartNumber'] ?? null,

            'strategy'       => $prefer,
            'brandRequested' => $brand,
            'brandMatched'   => $preferred !== [],
            'fallbackUsed'   => $brand !== null && $preferred === [],

            'needsReview'   => $needsReview,
            'reviewReason'  => $needsReview
                ? sprintf(
                    '%d distinct %s fitment groups returned — the correct size cannot be '.
                    'determined from the catalogue data.',
                    count($groups),
                    strtolower((string) ($fitment ?: 'compatible'))
                  )
                : null,

            'alternatives'  => $alternatives,
        ];
    }

    private function sorter(string $prefer): callable
    {
        $rank = fn ($p) => self::AVAILABILITY_RANK[$p['availability'] ?? ''] ?? 9;

        if ($prefer === 'price') {
            return fn ($a, $b) => [$a['customerPrice'], $rank($a)] <=> [$b['customerPrice'], $rank($b)];
        }

        return fn ($a, $b) => [$rank($a), $a['customerPrice']] <=> [$rank($b), $b['customerPrice']];
    }

    private function normaliseReg(string $reg): string
    {
        return strtoupper(preg_replace('/[^A-Za-z0-9]/', '', $reg));
    }
}
