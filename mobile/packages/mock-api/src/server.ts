import { serve } from "@hono/node-server";
import { createApp } from "./http";

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: createApp().fetch, port }, () => {
  console.log(`Ray'z mock API on http://localhost:${port}`);
});
