/** @type {import('next').NextConfig} */
const nextConfig = {
  // `output: 'export'` produces a fully static site (an `out/` folder of HTML/JS)
  // with no Node server required — exactly what S3 + CloudFront serve. This works
  // because the whole app is client-rendered (data is fetched in the browser via
  // GraphQL). `next dev` is unaffected; this only changes `next build`.
  output: "export",

  // trailingSlash makes each route export as a folder + index.html, which routes
  // more predictably on S3/CloudFront.
  trailingSlash: true,

  // The GraphQL API runs separately. We bake its URL in at build time.
  // Local dev falls back to localhost; production builds pass the real API URL, e.g.
  //   NEXT_PUBLIC_GRAPHQL_URL=https://api.gunbarrelstudio.com/ npm run build
  env: {
    NEXT_PUBLIC_GRAPHQL_URL: process.env.NEXT_PUBLIC_GRAPHQL_URL ?? "http://localhost:4000/",
  },
};

module.exports = nextConfig;
