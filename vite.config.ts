import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { feedMiddleware } from "./server/feeds.mjs";
import { createTranslationMiddleware } from "./server/translation.mjs";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    {
      name: "folio-feeds",
      transformIndexHtml(html, context) {
        return context.server
          ? html.replace(
              "script-src 'self'",
              "script-src 'self' 'unsafe-inline'",
            )
          : html;
      },
      configureServer(server) {
        server.middlewares.use(createTranslationMiddleware());
        server.middlewares.use(feedMiddleware);
      },
      configurePreviewServer(server) {
        server.middlewares.use(createTranslationMiddleware());
        server.middlewares.use(feedMiddleware);
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/release/**", "**/build/**", "**/.folio-*/**"] },
  },
});
