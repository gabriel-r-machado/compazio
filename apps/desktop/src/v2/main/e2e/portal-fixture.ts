import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";

export interface PortalFixture {
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** Deterministic local page used by integration and Electron Portal tests; it never reaches internet. */
export async function startPortalFixture(): Promise<PortalFixture> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/slow")
      return void setTimeout(() => send(response, page("Lenta", "<p>lenta</p>")), 2_000);
    if (url === "/error") return void send(response, "erro", 500);
    if (url === "/download") {
      response.writeHead(200, {
        "Content-Type": "text/plain",
        "Content-Disposition": "attachment; filename=fixture.txt"
      });
      response.end("download fixture");
      return;
    }
    if (url === "/second") return void send(response, page("Segunda", '<a href="/">Início</a>'));
    if (url === "/iframe")
      return void send(response, page("Iframe", '<button id="iframe-button">Iframe</button>'));
    if (url === "/spa-route")
      return void send(response, page("SPA", '<main id="spa-result">SPA pronta</main>'));
    if (url === "/visual-reference")
      return void send(
        response,
        page(
          "Referência visual",
          '<main style="background:#f6c945;color:#183153;padding:64px"><h1>FAROL AZUL</h1><p>Referência visual conectada</p></main>'
        )
      );
    send(
      response,
      page(
        "Portal fixture",
        `
      <h1>Portal de teste</h1><button id="increment" aria-label="Incrementar">Incrementar</button><output id="count">0</output>
      <label>Nome <input id="name" name="name" /></label><button id="send">Enviar</button><p id="result" aria-live="polite"></p>
      <label><input id="check" type="checkbox" /> Aceitar</label><label>Tipo <select id="select"><option>A</option><option>B</option></select></label>
      <a id="second" href="/second">Segunda página</a><a id="popup" href="/second" target="_blank">Popup</a><a id="download" href="/download">Download</a>
      <button id="permission">Permissão</button><button id="log">Console log</button><button id="error">Console error</button>
      <div style="height:1600px" id="scroll-content">Conteúdo rolável</div><iframe title="Iframe local" src="/iframe"></iframe>
      <script>
        // Named lookups (\`count\`, \`name\`) collide with the counter variable and with window.name,
        // so the fixture resolves every element explicitly and stays deterministic.
        var byId = function (id) { return document.getElementById(id); };
        var total = 0;
        byId('increment').onclick = function () { total += 1; byId('count').textContent = String(total); };
        byId('send').onclick = function () { byId('result').textContent = 'Olá, ' + byId('name').value; };
        byId('permission').onclick = function () {
          if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia)
            navigator.mediaDevices.getUserMedia({ audio: true }).catch(function () {});
        };
        byId('log').onclick = function () { console.log('fixture log'); };
        byId('error').onclick = function () { console.error('fixture error'); };
        localStorage.setItem('fixture', 'ok');
        document.cookie = 'fixture=ok; SameSite=Lax';
      </script>`
      )
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Fixture did not receive a TCP port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, close: () => close(server) };
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
}
function send(response: ServerResponse, body: string, status = 200): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}
function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error)))
  );
}
