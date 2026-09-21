<?php

namespace App\Console\Commands;

use App\Services\Gsf\GsfClient;
use App\Services\Gsf\GsfPriceService;
use Illuminate\Console\Command;

/**
 *   php artisan gsf:price P44PYN Wipers --brand=BOSCH
 *   php artisan gsf:price P44PYN Wipers --all
 *   php artisan gsf:price --whoami
 *   php artisan gsf:price --logout        (forces a fresh login next call)
 */
class GsfPriceCommand extends Command
{
    protected $signature = 'gsf:price
        {reg? : Vehicle registration, e.g. P44PYN}
        {category=Wipers : Category name as it appears in the GSF menu}
        {--brand= : Preferred brand, e.g. BOSCH}
        {--fitment=Front : Front, Rear, or "any"}
        {--prefer= : availability (default) or price}
        {--all : List every candidate instead of picking one}
        {--whoami : Show the current GSF session}
        {--logout : Clear the cached cookie jar}';

    protected $description = 'Look up a GSF TradeHub trade price (read-only)';

    public function handle(GsfPriceService $prices, GsfClient $client): int
    {
        if ($this->option('logout')) {
            $client->forgetSession();
            $this->info('Cached GSF session cleared.');
            return self::SUCCESS;
        }

        if ($this->option('whoami')) {
            $this->line(json_encode($client->sessionInfo(), JSON_PRETTY_PRINT));
            return self::SUCCESS;
        }

        $reg = $this->argument('reg');
        if (! $reg) {
            $this->error('A registration is required.');
            return self::FAILURE;
        }

        $fitment  = $this->option('fitment');
        $fitment  = ($fitment === 'any') ? null : $fitment;
        $category = $this->argument('category');

        if ($this->option('all')) {
            $rows = $prices->listParts($reg, $category, $fitment);
            $this->table(
                ['SKU', 'Brand', 'Fit', 'Group', 'Trade', 'RRP', 'Availability'],
                array_map(fn ($r) => [
                    $r['sku'], $r['brand'], $r['fitment'], $r['fitmentGroup'],
                    $r['tradePrice'], $r['rrp'], $r['availability'],
                ], $rows)
            );
            $this->line(sprintf('%d candidates.', count($rows)));
            return self::SUCCESS;
        }

        $result = $prices->getPartPrice(
            $reg, $category, $this->option('brand'), $fitment, $this->option('prefer')
        );

        $this->line(json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

        if ($result['needsReview'] ?? false) {
            $this->newLine();
            $this->warn('NEEDS REVIEW: '.$result['reviewReason']);
        }

        return ($result['found'] ?? false) ? self::SUCCESS : self::FAILURE;
    }
}
