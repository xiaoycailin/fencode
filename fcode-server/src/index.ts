import { createAppServer } from "./http.js";
import { loadStore } from "./store.js";

const port = Number(process.env.FCODE_SERVER_PORT || 32188);
const host = process.env.FCODE_SERVER_HOST || "127.0.0.1";

loadStore();

createAppServer().listen(port, host, () => {
  console.log(`fcode-server listening on http://${host}:${port}`);
});

