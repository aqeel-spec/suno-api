/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {},
  serverExternalPackages: [
    'rebrowser-playwright-core',
    'ghost-cursor-playwright',
    '@2captcha/captcha-solver',
    'pino',
    'pino-pretty',
  ],
  experimental: {
    serverMinification: false, // the server minification unfortunately breaks the selector class names
  },
};  

export default nextConfig;
