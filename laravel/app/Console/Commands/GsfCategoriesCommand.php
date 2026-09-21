<?php

namespace App\Console\Commands;

use App\Services\Gsf\GsfCategoryMap;
use Illuminate\Console\Command;

/**
 * Generate and inspect the category -> componentId map.
 *
 *   php artisan gsf:categories --export        # regenerate the JSON file
 *   php artisan gsf:categories wiper           # search the map
 *   php artisan gsf:categories --count
 *
 * Run --export ONCE at install, then commit the file. Price lookups read it
 * from disk and never call /api/menus. Re-run it only if GSF restructures
 * its catalogue (or a category name stops resolving).
 */
class GsfCategoriesCommand extends Command
{
    protected $signature = 'gsf:categories
        {search? : Substring to search for, e.g. "brake"}
        {--export : Fetch the live tree and rewrite the category file}
        {--path= : Write somewhere other than config(gsf.categories_file)}
        {--count : Just print how many categories are loaded}';

    protected $description = 'Build or inspect the GSF category -> componentId map';

    public function handle(GsfCategoryMap $categories): int
    {
        if ($this->option('export')) {
            $path = $this->option('path') ?: config('gsf.categories_file');
            $this->info('Fetching /api/menus ...');

            $written = $categories->export($path);

            $this->info("Wrote {$written} categories to {$path}");
            $this->line('Commit this file. Price lookups now read it from disk.');

            return self::SUCCESS;
        }

        $map = $categories->all();

        if ($this->option('count')) {
            $this->line((string) count($map));
            return self::SUCCESS;
        }

        if ($search = $this->argument('search')) {
            $hits = $categories->suggest($search);

            if ($hits === []) {
                $this->warn("No category matches \"{$search}\".");
                return self::FAILURE;
            }

            $this->table(
                ['Category', 'componentId'],
                array_map(fn ($c) => [$c, $map[$c]], $hits)
            );

            return self::SUCCESS;
        }

        $this->line(sprintf('%d categories loaded. Pass a search term to filter.', count($map)));
        $this->line('Example: php artisan gsf:categories wiper');

        return self::SUCCESS;
    }
}
