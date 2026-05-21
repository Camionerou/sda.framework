/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    const hardeningHeaders = [
      {
        key: "Permissions-Policy",
        value: "camera=(), geolocation=(), microphone=()"
      },
      {
        key: "Referrer-Policy",
        value: "strict-origin-when-cross-origin"
      },
      {
        key: "Strict-Transport-Security",
        value: "max-age=63072000; includeSubDomains"
      },
      {
        key: "X-Content-Type-Options",
        value: "nosniff"
      },
      {
        key: "X-Frame-Options",
        value: "DENY"
      },
      {
        key: "X-Robots-Tag",
        value: "noindex, nofollow"
      }
    ];
    const privateCacheHeaders = [
      {
        key: "Cache-Control",
        value: "private, no-store"
      }
    ];

    return [
      {
        headers: hardeningHeaders,
        source: "/:path*"
      },
      {
        headers: privateCacheHeaders,
        source: "/app/:path*"
      },
      {
        headers: privateCacheHeaders,
        source: "/api/:path*"
      },
      {
        headers: privateCacheHeaders,
        source: "/auth/:path*"
      },
      {
        headers: privateCacheHeaders,
        source: "/login"
      }
    ];
  },
  async redirects() {
    return [
      {
        destination: "/app",
        permanent: false,
        source: "/"
      }
    ];
  }
};

export default nextConfig;
