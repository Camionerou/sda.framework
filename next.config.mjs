/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
