import { Hono } from "hono";
import { cors } from "hono/cors";
import { routes } from "./routes";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: "http://localhost:5173",
  }),
);

app.route("/", routes);

export default app;
