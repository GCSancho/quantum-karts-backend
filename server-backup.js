// Backend mínimo em Node + Express para receber GameResult do Photon Quantum

const express = require("express");

const app = express();

// Middleware para parsear JSON do body
app.use(express.json());

// Segredo que vem no header X-SecretKey da Photon
// Configure isso na sua máquina/servidor como variável de ambiente
// Exemplo (Linux/macOS): PHOTON_WEBHOOK_SECRET=meuSegredo node server.js
// Exemplo (Windows PowerShell): $env:PHOTON_WEBHOOK_SECRET="meuSegredo"; node server.js
const PHOTON_WEBHOOK_SECRET = process.env.PHOTON_WEBHOOK_SECRET || "";

// Helper de log simpático
function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

if (!PHOTON_WEBHOOK_SECRET) {
  log("ATENÇÃO: PHOTON_WEBHOOK_SECRET não definido. As requisições da Photon serão rejeitadas com 401.");
}

// Rota simples de teste (GET /) para ver se o servidor está de pé
app.get("/", (req, res) => {
  res.send("Quantum backend OK");
});

// Rota que a Photon deve chamar com o GameResult
// Configure na Photon Dashboard a URL completa para algo como:
//   https://SEU-DOMINIO.com/game/result
app.post("/game/result", async (req, res) => {
  // 1. Verificar o segredo vindo da Photon
  const secret = req.header("X-SecretKey");
  if (!secret || secret !== PHOTON_WEBHOOK_SECRET) {
    log("Webhook com secret inválido ou ausente, IP:", req.ip);
    return res.sendStatus(401); // Unauthorized
  }

  // 2. Ler payload
  const gameResults = req.body;

  if (!Array.isArray(gameResults) || gameResults.length === 0) {
    log("Payload de GameResult vazio ou formato inesperado.");
    return res.sendStatus(400); // Bad Request
  }

  // Normalmente a Photon envia um array de GameResultInfo.
  // Para simplicidade, pegamos o primeiro.
  const gameResultInfo = gameResults[0];

  const result = gameResultInfo.Result;
  const clients = gameResultInfo.Clients || [];

  if (!result || !Array.isArray(result.Players)) {
    log("Result.Players não encontrado no payload.");
    return res.sendStatus(400);
  }

  try {
    // 3. Para cada jogador do GameResult, mapeia PlayerSlot -> UserId
    for (const playerResult of result.Players) {
      const slot = playerResult.PlayerSlot;

      const clientInfo = clients.find((c) => c.PlayerSlot === slot);
      if (!clientInfo) {
        log(`Nenhum Client encontrado para PlayerSlot ${slot}, ignorando.`);
        continue;
      }

      // Lembra: idealmente UserId == AuthenticationService.Instance.PlayerId no cliente Unity
      const unityPlayerId = clientInfo.UserId;

      const placement = playerResult.Placement;
      const xpEarned = playerResult.XpEarned || 0;
      const goldEarned = playerResult.GoldEarned || 0;

      log(
        `Resultado recebido - playerId=${unityPlayerId} slot=${slot} ` +
          `placement=${placement} xpEarned=${xpEarned} goldEarned=${goldEarned}`
      );

      // 4. Aqui é onde você realmente daria XP/Gold (Cloud Save, DB, etc)
      // Por enquanto, a função só loga. Isso já compila e roda sem precisar de nada extra.
      await awardXpAndGold(unityPlayerId, xpEarned, goldEarned);
    }

    // Responder 200 para indicar que o webhook foi processado com sucesso
    return res.sendStatus(200);
  } catch (err) {
    console.error("Erro ao processar /game/result:", err);
    // Photon pode tentar reenviar dependendo da configuração, mas aqui é ok retornar 500.
    return res.sendStatus(500);
  }
});

// Função mínima: neste backend "versão 1" ela só loga.
// Depois podemos substituir isso por chamadas reais ao Unity Cloud Save.
async function awardXpAndGold(playerId, xp, gold) {
  log(`[awardXpAndGold] playerId=${playerId} xp+${xp} gold+${gold}`);
  // TODO: no futuro:
  //  - ler XP/Ouro atuais do Cloud Save
  //  - somar xp/gold
  //  - gravar em Protected Player Data via REST
}

// Sobe o servidor HTTP
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log(`Servidor Quantum backend ouvindo na porta ${PORT}`);
});