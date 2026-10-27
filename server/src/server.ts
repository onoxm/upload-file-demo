import { serve } from "@hono/node-server";
import app from "./app";

const port = 9527;

const startServer = () => {
  serve({
    fetch: app.fetch,
    port,
  });
  console.log(`running in ${port}`);
};

startServer();
