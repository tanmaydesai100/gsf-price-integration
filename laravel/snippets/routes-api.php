<?php
// routes/api.php — add this. Keep it behind authentication: it returns trade cost.

use App\Http\Controllers\Api\GsfPriceController;
use Illuminate\Support\Facades\Route;

Route::middleware(['auth:sanctum', 'throttle:30,1'])->group(function () {
    Route::post('/gsf/part-price', [GsfPriceController::class, 'show']);
});
