<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Services\Gsf\Exceptions\GsfAuthException;
use App\Services\Gsf\Exceptions\GsfBlockedException;
use App\Services\Gsf\Exceptions\GsfException;
use App\Services\Gsf\GsfPriceService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

class GsfPriceController extends Controller
{
    public function __construct(private GsfPriceService $prices) {}

    /**
     * POST /api/gsf/part-price
     * { "registration": "P44PYN", "category": "Wipers", "brand": "BOSCH" }
     *
     * Put this behind auth — it exposes trade cost. Never call GSF from the
     * browser directly: CORS blocks it, and it would leak the session cookie
     * and our buying prices to anyone who opens DevTools.
     */
    public function show(Request $request): JsonResponse
    {
        $data = $request->validate([
            'registration' => ['required', 'string', 'max:12'],
            'category'     => ['required', 'string', 'max:60'],
            'brand'        => ['nullable', 'string', 'max:40'],
            'fitment'      => ['nullable', 'string', 'in:Front,Rear'],
            'prefer'       => ['nullable', 'string', 'in:availability,price'],
        ]);

        try {
            $result = $this->prices->getPartPrice(
                $data['registration'],
                $data['category'],
                $data['brand']   ?? null,
                $data['fitment'] ?? 'Front',
                $data['prefer']  ?? null,
            );

            return response()->json($result, $result['found'] ? 200 : 404);

        } catch (GsfBlockedException $e) {
            // Edge block. Do not let the caller hammer us into a harder block.
            return response()->json([
                'error'   => 'supplier_blocked',
                'message' => 'GSF is refusing automated requests from this server right now.',
            ], 503);

        } catch (GsfAuthException $e) {
            return response()->json([
                'error'   => 'supplier_auth',
                'message' => 'Could not sign in to GSF. Credentials or session need attention.',
            ], 503);

        } catch (GsfException $e) {
            return response()->json([
                'error'   => 'supplier_error',
                'message' => $e->getMessage(),
            ], 502);
        }
    }
}
