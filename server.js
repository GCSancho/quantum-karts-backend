// server.js
// Backend mínimo Quantum + Unity Cloud Save (Protected Player Data)

require("dotenv").config();

const http = require("http");
const https = require("https");

// ============================
// CONFIGURAÇÃO (via env vars)
// ============================

// Segredo que a Photon envia no header X-SecretKey
const PHOTON_WEBHOOK_SECRET = process.env.PHOTON_WEBHOOK_SECRET || "";

// Unity Project / Environment
const UNITY_PROJECT_ID = process.env.UNITY_PROJECT_ID || "";
const UNITY_ENVIRONMENT_ID = process.env.UNITY_ENVIRONMENT_ID || "";

// Service Account (criado no Dashboard > Administration > Service Accounts)
const UNITY_SA_KEY_ID = process.env.UNITY_SA_KEY_ID || "";
const UNITY_SA_SECRET = process.env.UNITY_SA_SECRET || "";

// Porta do servidor local
const PORT = process.env.PORT || 3000;

// Cloud script que processa os dados do game result
const CLOUD_CODE_SCRIPT_NAME = process.env.CLOUD_CODE_SCRIPT_NAME || "ProcessPhotonGameResult";

// ============================
// Helpers HTTP (para REST)
// ============================

/**
 * Faz uma requisição HTTPS e retorna { statusCode, headers, body, json }
 */
function httpsJsonRequest({ hostname, path, method = "GET", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          let parsed = null;
          try {
            if (data && data.length > 0) {
              parsed = JSON.parse(data);
            }
          } catch (e) {
            // Se não for JSON, mantém parsed = null
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
            json: parsed,
          });
        });
      }
    );

    req.on("error", (err) => {
      reject(err);
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

// ============================================
// Unity: Token Exchange (Service Account -> accessToken)
// ============================================

/**
 * Obtém um accessToken de serviço para o projeto/ambiente via Token Exchange API.
 * Docs: https://services.api.unity.com/auth/v1/token-exchange?projectId=...&environmentId=...
 */
async function getUnityAccessToken() {
  if (!UNITY_PROJECT_ID || !UNITY_ENVIRONMENT_ID || !UNITY_SA_KEY_ID || !UNITY_SA_SECRET) {
    console.warn(
      "Unity env vars ausentes (UNITY_PROJECT_ID, UNITY_ENVIRONMENT_ID, UNITY_SA_KEY_ID, UNITY_SA_SECRET). " +
        "Cloud Save NÃO será chamado."
    );
    return null;
  }

  const credentials = Buffer.from(`${UNITY_SA_KEY_ID}:${UNITY_SA_SECRET}`).toString("base64");

  const path =
    `/auth/v1/token-exchange` +
    `?projectId=${encodeURIComponent(UNITY_PROJECT_ID)}` +
    `&environmentId=${encodeURIComponent(UNITY_ENVIRONMENT_ID)}`;

  console.log("Chamando Token Exchange API da Unity...");

  const { statusCode, body, json } = await httpsJsonRequest({
    hostname: "services.api.unity.com",
    path,
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
    },
  });

  if (statusCode < 200 || statusCode >= 300) {
    console.error("Falha no Token Exchange:", statusCode, body);
    throw new Error("Token Exchange falhou");
  }

  if (!json || !json.accessToken) {
    console.error("Resposta do Token Exchange sem accessToken:", body);
    throw new Error("Token Exchange sem accessToken");
  }

  console.log("Token Exchange OK.");
  return json.accessToken;
}

/**
 * Envia o GameResult bruto para o script Cloud Code.
 * gameResultPayload = o JSON já parseado recebido do Photon (o body inteiro).
 */
async function callCloudCodeGameResultHandler(gameResultPayload) {
  const accessToken = await getUnityAccessToken();

  const body = JSON.stringify({
    // Esse objeto "params" vira o "params" do script Cloud Code
    params: {
      photonGameResult: gameResultPayload
      //test: "ping from backend"
    }
  });

  const options = {
    hostname: "cloud-code.services.api.unity.com",
    // ⚠ Dependendo da versão da API, o path pode ser /scripts/{name} ou /scripts/{name}/run.
    // Se tomar 404, ajuste para remover ou adicionar o "/run" conferindo na doc da Cloud Code Client API.
    path: `/v1/projects/${UNITY_PROJECT_ID}/scripts/${CLOUD_CODE_SCRIPT_NAME}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "Content-Length": Buffer.byteLength(body)
    }
  };

  console.log("[CloudCode] Chamando script", CLOUD_CODE_SCRIPT_NAME);

  //const response = await httpsJsonRequest(options, body);
  const response = await httpsJsonRequest({
    hostname: "cloud-code.services.api.unity.com",
    path: `/v1/projects/${UNITY_PROJECT_ID}/scripts/${CLOUD_CODE_SCRIPT_NAME}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body
  });

  console.log("[CloudCode] Resposta do script:", JSON.stringify(response));
  return response;
}

// ============================================
// Unity Cloud Save: salvar XP/Gold protegidos
// ============================================

/**
 * Escreve dados protegidos do jogador na Cloud Save (ex: totalXp, totalGold).
 *
 * IMPORTANTE:
 * - Endpoint exato da Cloud Save Player API para Protected Items pode mudar;
 *   confira a doc de Cloud Save Player API (SetProtectedItemBatch) se precisar ajustar.
 * - Neste exemplo, estamos só gravando os valores recebidos do resultado da corrida.
 *   Se quiser somar com o que já existe, você pode:
 *     1) Ler os itens atuais (getProtectedItems),
 *     2) Somar xp/gold,
 *     3) Escrever de volta.
 */

// ============================================
// Unity Cloud Save: salvar XP/Gold (Player Data default /items)
// ============================================

async function savePlayerRewardsToCloudSave(playerId, xpEarned, goldEarned) {
  if (!UNITY_PROJECT_ID) {
    console.warn("UNITY_PROJECT_ID não configurado. Ignorando chamada ao Cloud Save.");
    return;
  }

  const accessToken = await getUnityAccessToken();
  if (!accessToken) {
    console.warn("Sem accessToken da Unity. Não foi possível salvar no Cloud Save.");
    return;
  }

  // Vamos salvar como dados da última partida nas chaves "lastMatchXp" e "lastMatchGold".
  // Endpoint confirmado na documentação:
  //   POST https://cloud-save.services.api.unity.com/v1/data/projects/{projectId}/players/{playerId}/items
  //
  // Body:
  //   { "key": "algumaChave", "value": qualquerValorJson }

  const itemsToSave = [
    { key: "lastMatchXp",   value: xpEarned },
    { key: "lastMatchGold", value: goldEarned },
  ];

  for (const item of itemsToSave) {
    const bodyJson = JSON.stringify(item);

    const path =
      `/v1/data/projects/${encodeURIComponent(UNITY_PROJECT_ID)}` +
      `/players/${encodeURIComponent(playerId)}` +
      `/items`;

    console.log(
      `Chamando Cloud Save /items para playerId=${playerId} key=${item.key} value=${item.value}`
    );

    const { statusCode, body } = await httpsJsonRequest({
      hostname: "cloud-save.services.api.unity.com",
      path,
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: bodyJson,
    });

    if (statusCode < 200 || statusCode >= 300) {
      console.error(
        `Falha ao salvar Cloud Save para playerId=${playerId} key=${item.key}:`,
        statusCode,
        body
      );
      throw new Error("Cloud Save setItem falhou");
    }

    console.log(`Cloud Save OK para playerId=${playerId}, key=${item.key}`);
  }
}

// ============================================
// Lógica de processamento do GameResult
// ============================================

/**
 * Entra aqui o JSON já parseado do corpo da requisição Photon.
 * Exemplo (simplificado, igual ao Teste 2):
 * [
 *   {
 *     "Result": {
 *       "Players": [
 *         { "PlayerSlot": 0, "Placement": 1, "XpEarned": 100, "GoldEarned": 50 }
 *       ]
 *     },
 *     "Clients": [
 *       { "PlayerSlot": 0, "UserId": "TEST_PLAYER_ID" }
 *     ]
 *   }
 * ]
 */
async function handleGameResult(parsedBody) {
  console.log("[Webhook] GameResult recebido do Photon, encaminhando para Cloud Code...");

  try {
    const cloudCodeResponse = await callCloudCodeGameResultHandler(parsedBody);

    if (cloudCodeResponse.statusCode >= 200 && cloudCodeResponse.statusCode < 300) {
      console.log("[Webhook] Cloud Code processou GameResult com sucesso.");
    } else {
      console.error(
        `[Webhook] Cloud Code retornou erro: status=${cloudCodeResponse.statusCode}, body=${cloudCodeResponse.body}`
      );
    }
  } catch (err) {
    console.error("[Webhook] Erro ao chamar Cloud Code para GameResult:", err);
  }
}

// ============================================
// Servidor HTTP (igual antes, com integração)
// ============================================

console.log("Iniciando backend Quantum...");
if (!PHOTON_WEBHOOK_SECRET) {
  console.log(
    "ATENÇÃO: PHOTON_WEBHOOK_SECRET não definido. As requisições serão aceitas sem validação de segredo."
  );
}

const server = http.createServer((req, res) => {
  console.log(new Date().toISOString(), "-", req.method, req.url);

  // Rota de teste (GET /)
  if (req.method === "GET" && req.url === "/") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/plain");
    res.end("Quantum backend OK\n");
    return;
  }

  // Rota principal do webhook (POST /game/result)
  if (req.method === "POST" && req.url === "/game/result") {
    // Validação do segredo vindo da Photon
    const secret = req.headers["x-secretkey"];

    if (PHOTON_WEBHOOK_SECRET && secret !== PHOTON_WEBHOOK_SECRET) {
      console.log("Secret inválido. Recebido:", secret);
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      console.log("Headers:", req.headers);
      console.log("Body bruto recebido:", body);

      let parsed = null;
      try {
        parsed = JSON.parse(body);
        console.log("JSON parseado com sucesso.");
      } catch (e) {
        console.log("Falha ao parsear JSON:", e.message);
      }

      if (parsed) {
        try {
          await handleGameResult(parsed);
        } catch (err) {
          console.error("Erro em handleGameResult:", err.message);
          // Mesmo com erro, respondemos 200 para não gerar retry infinito (depende da sua estratégia)
        }
      }

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/plain");
      res.end("OK\n");
    });

    return;
  }

  // Qualquer outra rota
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain");
  res.end("Not Found\n");
});

server.listen(PORT, () => {
  console.log(`Servidor Quantum backend ouvindo em http://localhost:${PORT}`);
});