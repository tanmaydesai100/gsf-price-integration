<?php

namespace App\Services\Gsf\Exceptions;

/**
 * 401, or a login that was rejected. The session is dead; re-authentication
 * is the correct response.
 */
class GsfAuthException extends GsfException {}
