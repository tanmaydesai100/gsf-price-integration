<?php

namespace App\Services\Gsf\Exceptions;

/**
 * 403 — DataDome or a WAF. NEVER retry this: retrying escalates the block.
 * A human needs to capture fresh cookies from a real browser on this server's
 * egress IP, or raise it with GSF.
 */
class GsfBlockedException extends GsfException {}
