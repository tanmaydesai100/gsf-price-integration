const int = (value, fallback) => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  baseUrl: process.env.JLR_EPC_BASE_URL || 'https://www.jlrepc.com',
  email: process.env.JLR_EPC_EMAIL || null,
  password: process.env.JLR_EPC_PASSWORD || null,
  cataloguePath:
    process.env.JLR_CATALOGUE_PATH ||
    '/mobify/proxy/apigee/iepc/catalogue/api/v1/catEntries',
  retailerCode: process.env.JLR_RETAILER_CODE || null,
  retailerId: process.env.JLR_RETAILER_ID || null,
  userType: process.env.JLR_USER_TYPE || 'independent',
  userRole: process.env.JLR_USER_ROLE || 'sponsored',
  marketCode: process.env.JLR_MARKET_CODE || 'GB',
  langCode: process.env.JLR_LANG_CODE || 'EN',
  sessionCookie: process.env.JLR_SESSION_COOKIE || null,
  apigeeToken: process.env.JLR_APIGEE_TOKEN || null,
  authBaseUrl: process.env.JLR_AUTH_BASE_URL || 'https://enterprise.jaguarlandrover.com/business/auth',
  authRealm: process.env.JLR_AUTH_REALM || 'enterprise',
  authTree: process.env.JLR_AUTH_TREE || 'iepc-login',
  profileDir: process.env.JLR_PROFILE_DIR || 'jlr/.jlr-profile',
  browserHeadless: process.env.JLR_BROWSER_HEADLESS === 'true',
  loginTimeout: int(process.env.JLR_LOGIN_TIMEOUT, 120) * 1000,
  timeout: int(process.env.JLR_TIMEOUT, 60) * 1000,
};