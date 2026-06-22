import { buildHttpServer } from "./http.js";

const port = Number(process.env.PORT ?? 3001);

buildHttpServer()
  .then((app) => app.listen({ port, host: "0.0.0.0" }))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
