/**
 * Cidade Dorme / Mafia - versão completa (single file)
 * Requisitos:
 *  - Node.js
 *  - discord.js v14
 *  - .env com TOKEN, GUILD_ID, CHANNEL_ID
 *
 * Observações:
 *  - Tempo de ação da noite: 15s por ação (com prompts e await)
 *  - Votação: 30s
 *  - Psicopata: rola dado 1-6 (ímpar = mata, par = salvo) -> 50% efetivo
 *  - Feiticeira: revive (pode usar desde 1ª noite), veneno disponível a partir da 2ª noite
 *  - Apenas 1 poção por rodada pode ser usada pela Feiticeira (reviver OU envenenar)
 *  - Aprendiz: substitui Assassino se Assassino não agir em 10s; tem 1x de salvar durante votação
 *  - Mercenário: recebe 3 nomes (1 é o alvo real). O alvo real permanece até morrer.
 *  - Caçador é revelado no início; se morrer, pode escolher um alvo em 10s para matar
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, SlashCommandBuilder, REST, Routes } = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('Faltando TOKEN, GUILD_ID ou CHANNEL_ID no .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/**
 * mafia-bot.txt (cole como index.js)
 *
 * Mafia / Cidade Dorme - Versão completa (single file)
 * Requisitos:
 *  - Node.js
 *  - discord.js v14
 *  - .env com TOKEN, GUILD_ID, CHANNEL_ID
 *
 * Fluxo implementado:
 *  - /cidade cria lobby com botões Entrar / Iniciar
 *  - Vidente -> Anjo -> Noite -> Assassino / Psicopata / Mercenário / Feiticeira -> aplicação de ações -> revelações -> votação
 *  - Psicopata rola dado (1-6): ímpar = mata, par = salvo (50%)
 *  - Feiticeira: reviver disponível desde a 1ª noite (1x), veneno disponível a partir da 2ª noite (1x), apenas 1 poção por rodada
 *  - Mercenário: recebe 3 nomes no canal (um correto), escolhe por DM (se errar, morre; se acertar, alvo morre)
 *  - Aprendiz de Assassino substitui assassino se ele não agir em 10s; Aprendiz pode salvar uma vez em votação
 *  - Caçador: revelado no início; ao morrer recebe DM com 10s para escolher um alvo e matar
 *  - Votação: 30s; desempate = ninguém sai; todos podem votar
 *  - Sempre que alguém morre, o cargo é revelado
 *  - Vitória automática: civis vencem se todas as máfias mortas; máfia vence se mafiasAlive >=1 && civisAlive <=2
 *
 * Observações:
 *  - O código usa DM com texto (digitar nome exato do jogador). Você pode substituir por botões mais avançados posteriormente.
 *  - Teste com um servidor de teste e 5+ contas (ou convide amigos) para verificar fluxo.
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, Events, SlashCommandBuilder, REST, Routes } = require('discord.js');

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CHANNEL_ID = process.env.CHANNEL_ID;

if (!TOKEN || !GUILD_ID || !CHANNEL_ID) {
  console.error('ERRO: Defina TOKEN, GUILD_ID e CHANNEL_ID no .env');
  process.exit(1);
}

/* ---------- TEMPOS (ms) ---------- */
const TIME_ASSASSIN_FALLBACK = 10000; // 10s (assassino primeira janela)
const TIME_ACTION = 15000; // 15s para demais ações da noite
const TIME_VOTE = 30000; // 30s votação
const TIME_CACADOR = 10000; // 10s para caçador executar

/* ---------- INICIALIZAÇÃO ---------- */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

/* ---------- ESTADO GLOBAL ---------- */
let lobby = new Map(); // userId -> username
let jogo = null; // objeto do jogo quando iniciado

/* ---------- HELPERS ---------- */
function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mention(id) { return `<@${id}>`; }

// retorna player object by role alive
function findAliveRole(role) {
  if (!jogo) return null;
  return Array.from(jogo.players.values()).find(p => p.role === role && p.alive) || null;
}
function alivePlayersList() {
  if (!jogo) return [];
  return Array.from(jogo.players.values()).filter(p => p.alive);
}
function aliveTargetsForMafia() {
  return alivePlayersList().filter(p => !['Assassino','Aprendiz de Assassino','Psicopata'].includes(p.role)).map(p => ({ id: p.userId, label: p.username }));
}
function aliveTargetsAll() {
  return alivePlayersList().map(p => ({ id: p.userId, label: p.username }));
}
async function dmSend(userId, content) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(content);
    return true;
  } catch (err) {
    console.warn('Não foi possível DM:', userId);
    return false;
  }
}
// solicita escolha via DM textual: usuário digita nome exato, 'passar' ou retorna null
async function solicitarEscolhaDM(userId, promptText, validTargets, time = TIME_ACTION) {
  try {
    const u = await client.users.fetch(userId);
    const dm = await u.createDM();
    let listText = validTargets.map(t => `- ${t.label}`).join('\n');
    await dm.send(`${promptText}\nAlvos:\n${listText}\nDigite o NOME (exato) do jogador ou 'passar'. Você tem ${Math.round(time/1000)}s.`);
    const filter = m => m.author.id === userId;
    const collected = await dm.awaitMessages({ filter, max: 1, time, errors: ['time'] }).catch(() => null);
    if (!collected || !collected.first()) return null;
    const reply = collected.first().content.trim();
    if (reply.toLowerCase() === 'passar') return null;
    const lower = reply.toLowerCase();
    const match = validTargets.find(t => t.label.toLowerCase() === lower || t.id === reply || `<@${t.id}>` === reply);
    return match ? match.id : null;
  } catch (err) {
    console.warn('solicitarEscolhaDM erro:', err);
    return null;
  }
}

/* ---------- Registrar slash /cidade (guild only) ---------- */
client.once(Events.ClientReady, async () => {
  console.log('Bot online:', client.user.tag);
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const cmd = new SlashCommandBuilder().setName('cidade').setDescription('Abre o lobby do jogo Cidade Dorme').toJSON();
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [cmd] });
    console.log('Comando /cidade registrado.');
  } catch (err) {
    console.error('Erro registrando comando:', err);
  }
});

/* ---------- Interações: lobby / botões ---------- */
client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'cidade') {
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Apenas admins podem abrir o lobby.', ephemeral: true });
      if (jogo) return interaction.reply({ content: 'Já existe um jogo em andamento.', ephemeral: true });

      lobby.clear();
      const entrarBtn = new ButtonBuilder().setCustomId('entrar_lobby').setLabel('🎮 Entrar no Jogo').setStyle(ButtonStyle.Success);
      const iniciarBtn = new ButtonBuilder().setCustomId('iniciar_jogo').setLabel('🚀 Iniciar Jogo (Admin)').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(entrarBtn, iniciarBtn);

      await interaction.reply({ content: '**LOBBY** — Clique em Entrar para participar. Quando todos entrarem, um admin deve clicar em Iniciar.', components: [row] });
      return;
    }

    if (interaction.isButton()) {
      const id = interaction.customId;
      if (id === 'entrar_lobby') {
        if (jogo) return interaction.reply({ content: '⏳ Jogo já começou', ephemeral: true });
        if (lobby.has(interaction.user.id)) return interaction.reply({ content: 'Você já entrou no lobby.', ephemeral: true });
        lobby.set(interaction.user.id, interaction.user.username);
        return interaction.reply({ content: `✅ ${interaction.user.username} entrou no lobby! (${lobby.size})`, ephemeral: true });
      }
      if (id === 'iniciar_jogo') {
        if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Apenas admins podem iniciar.', ephemeral: true });
        if (jogo) return interaction.reply({ content: 'Jogo já em andamento.', ephemeral: true });
        if (lobby.size < 5) return interaction.reply({ content: 'Mínimo 5 jogadores para iniciar.', ephemeral: true });
        await interaction.reply({ content: '🎲 Iniciando o jogo... enviando cargos via DM.', ephemeral: true });
        const channel = await client.channels.fetch(CHANNEL_ID);
        iniciarPartida(channel);
        return;
      }
    }
  } catch (err) {
    console.error('interaction error:', err);
  }
});

/* ---------- Iniciar partida: distribuir cargos e enviar DMs ---------- */
async function iniciarPartida(channel) {
  jogo = {
    channelId: CHANNEL_ID,
    players: new Map(), // userId -> { userId, username, role, alive, usedAprendizSave, feiticeiraReviveUsed, feiticeiraPoisonUsed }
    round: 0,
    nightCount: 0,
    dead: [], // array {id, name, role}
    anjoSave: null,
    mercTrueTarget: null,
    feiticeiraUsedThisRound: false
  };

  const playerIds = Array.from(lobby.keys());
  // Mandatory roles
  const mandatory = ['Assassino','Aprendiz de Assassino','Psicopata','Feiticeira','Anjo','Vidente','Caçador'];
  let roles = [...mandatory];
  while (roles.length < playerIds.length) roles.push('Civil');
  roles = shuffle(roles).slice(0, playerIds.length);

  for (let i = 0; i < playerIds.length; i++) {
    const id = playerIds[i];
    const role = roles[i] || 'Civil';
    jogo.players.set(id, {
      userId: id,
      username: lobby.get(id),
      role,
      alive: true,
      usedAprendizSave: false,
      feiticeiraReviveUsed: false,
      feiticeiraPoisonUsed: false
    });
  }

  // Send DMs
  for (const [id, p] of jogo.players) {
    const ok = await dmSend(id, `🎭 Seu cargo: **${p.role}**\nSiga as instruções enviadas por DM para realizar ações quando solicitado.`);
    if (!ok) {
      await channel.send(`⚠️ ${p.username}, habilite DMs para receber seu cargo.`);
    }
  }

  // Reveal caçador publicly
  const cacador = Array.from(jogo.players.values()).find(p => p.role === 'Caçador');
  if (cacador) {
    await channel.send(`🔍 O Caçador foi revelado: **${cacador.username}** (Cargo: Caçador).`);
  }

  lobby.clear();
  await sleep(1000);
  mainLoop().catch(err => console.error('mainLoop erro', err));
}

/* ---------- Main loop (Vidente → Anjo → Noite → Votação) ---------- */
async function mainLoop() {
  const canal = await client.channels.fetch(jogo.channelId);
  while (jogo) {
    if (verificarVitoria(canal)) break;
    jogo.nightCount++;
    jogo.round++;
    // Vidente
    await canal.send(`🌞 **Dia ${jogo.round} — Vidente escolha alvo (via DM).**`);
    await faseVidente();
    // Anjo
    await canal.send(`👼 **Anjo escolha alguém para salvar (via DM).**`);
    await faseAnjo();
    // Noite
    await canal.send(`🌙 **Noite ${jogo.nightCount} — façam suas ações por DM (15s por ação).**`);
    await noiteFase();
    if (verificarVitoria(canal)) break;
    // Votação
    await canal.send(`🗳️ **Votação do Dia ${jogo.round} — 30s para votar! (digite: votar nome_do_jogador)**`);
    await votacaoFase();
    if (verificarVitoria(canal)) break;
    // Small pause
    await sleep(1000);
  }
}

/* ---------- Fase Vidente ---------- */
async function faseVidente() {
  const vidente = findAliveRole('Vidente');
  if (!vidente) return;
  const targets = aliveTargetsAll().filter(t => t.id !== vidente.userId);
  if (targets.length === 0) {
    await dmSend(vidente.userId, 'Sem alvos disponíveis.');
    return;
  }
  const chosenId = await solicitarEscolhaDM(vidente.userId, '🔎 Vidente: escolha uma pessoa para investigar (você receberá o cargo dela).', targets, TIME_ACTION);
  if (!chosenId) {
    await dmSend(vidente.userId, '⏳ Você não escolheu. Ação perdida.');
    return;
  }
  const alvo = jogo.players.get(chosenId);
  if (!alvo) { await dmSend(vidente.userId, 'Alvo inválido.'); return; }
  const oldRole = vidente.role;
  vidente.role = alvo.role;
  jogo.players.set(vidente.userId, vidente);
  await dmSend(vidente.userId, `🔎 Investigado: ${alvo.username} tem o cargo **${alvo.role}**. Seu cargo agora é **${vidente.role}** (antes era: ${oldRole}).`);
}

/* ---------- Fase Anjo ---------- */
async function faseAnjo() {
  const anjo = findAliveRole('Anjo');
  if (!anjo) { jogo.anjoSave = null; return; }
  const targets = aliveTargetsAll().filter(t => t.id !== anjo.userId);
  if (targets.length === 0) { jogo.anjoSave = null; await dmSend(anjo.userId, 'Sem alvos.'); return; }
  const chosen = await solicitarEscolhaDM(anjo.userId, '👼 Anjo: escolha alguém para salvar na próxima resolução da noite (não pode salvar a si mesmo).', targets, TIME_ACTION);
  if (!chosen) { jogo.anjoSave = null; await dmSend(anjo.userId, '⏳ Você não escolheu.'); return; }
  if (chosen === anjo.userId) { jogo.anjoSave = null; await dmSend(anjo.userId, 'Você não pode salvar a si mesmo.'); return; }
  jogo.anjoSave = chosen;
  await dmSend(anjo.userId, `🛡️ Você escolheu salvar **${jogo.players.get(chosen).username}** nesta noite.`);
}

/* ---------- Fase Noite (todas as ações) ---------- */
async function noiteFase() {
  const canal = await client.channels.fetch(jogo.channelId);
  // reset per-night actions
  jogo.nightActions = {
    assassinTarget: null,
    psicopataActions: [],
    mercenarioChoice: null,
    mercenarioChoicesList: null,
    feiticeiraAction: null // {type, targetId}
  };
  jogo.feiticeiraUsedThisRound = false;

  /* ----- ASSASSINO (10s), fallback aprendiz ----- */
  const assassino = findAliveRole('Assassino');
  const aprendiz = findAliveRole('Aprendiz de Assassino');
  if (assassino) {
    const mafiaTargets = aliveTargetsForMafia();
    const chosen = await solicitarEscolhaDM(assassino.userId, '🔪 Assassino: escolha uma vítima (não pode matar máfia). Você tem 10s.', mafiaTargets, TIME_ASSASSIN_FALLBACK);
    if (chosen) {
      jogo.nightActions.assassinTarget = chosen;
      await dmSend(assassino.userId, '✅ Ataque registrado (anônimo).');
    } else {
      if (aprendiz) {
        const chosenA = await solicitarEscolhaDM(aprendiz.userId, '🗡️ Aprendiz: Assassino não agiu. Você pode escolher uma vítima em 10s.', mafiaTargets, TIME_ASSASSIN_FALLBACK);
        if (chosenA) {
          jogo.nightActions.assassinTarget = chosenA;
          await dmSend(aprendiz.userId, '✅ Você agiu como Aprendiz e registrou o ataque.');
        } else {
          await canal.send('⚠️ Assassino e Aprendiz não atuaram esta noite.');
        }
      } else {
        await canal.send('⚠️ Assassino não escolheu e não há Aprendiz disponível.');
      }
    }
  } else if (aprendiz) {
    // Assassino morto, Aprendiz age por padrão
    const mafiaTargets = aliveTargetsForMafia();
    const chosenA = await solicitarEscolhaDM(aprendiz.userId, '🗡️ Aprendiz (Assassino ausente): escolha uma vítima em 15s.', mafiaTargets, TIME_ACTION);
    if (chosenA) {
      jogo.nightActions.assassinTarget = chosenA;
      await dmSend(aprendiz.userId, '✅ Ataque registrado.');
    }
  }

  /* ----- PSICOPATA (15s) ----- */
  const psicopata = findAliveRole('Psicopata');
  if (psicopata) {
    const targets = aliveTargetsAll().filter(t => t.id !== psicopata.userId);
    const chosenP = await solicitarEscolhaDM(psicopata.userId, '🌀 Psicopata: escolha um alvo para girar o dado (ímpar = morte, par = salvo).', targets, TIME_ACTION);
    if (chosenP) {
      const dado = Math.floor(Math.random() * 6) + 1;
      const resultKill = (dado % 2 === 1);
      jogo.nightActions.psicopataActions.push({ byId: psicopata.userId, targetId: chosenP, dado, resultKill });
      await dmSend(psicopata.userId, `🎲 Dado: ${dado}. Resultado: ${resultKill ? 'MORTE' : 'SALVO'}.`);
    } else {
      await dmSend(psicopata.userId, '⏳ Você não escolheu.');
    }
  }

  /* ----- MERCENÁRIO (15s) ----- */
  const merc = findAliveRole('Mercenário');
  if (merc) {
    // Choose or maintain true target
    if (!jogo.mercTrueTarget || !jogo.players.get(jogo.mercTrueTarget) || !jogo.players.get(jogo.mercTrueTarget).alive) {
      // pick random alive not merc
      const pool = aliveTargetsAll().map(t => t.id).filter(id => id !== merc.userId);
      if (pool.length > 0) jogo.mercTrueTarget = pool[Math.floor(Math.random() * pool.length)];
    }
    // prepare choices: true target + 2 decoys
    const aliveIds = aliveTargetsAll().map(t => t.id).filter(id => id !== merc.userId && id !== jogo.mercTrueTarget);
    shuffle(aliveIds);
    const decoys = aliveIds.slice(0, 2);
    const choices = shuffle([jogo.mercTrueTarget, ...decoys]);
    jogo.nightActions.mercenarioChoicesList = choices;
    // publicize choices in channel
    const names = choices.map(id => jogo.players.get(id)?.username || id);
    await canal.send(`🎯 Mercenário — 3 nomes (um é o alvo correto):\n• ${names[0]}\n• ${names[1]}\n• ${names[2]}\n(O Mercenário deve escolher por DM qual dos 3 é o alvo correto.)`);
    const choicesForMerc = choices.map(id => ({ id, label: jogo.players.get(id).username }));
    const chosenM = await solicitarEscolhaDM(merc.userId, '💼 Mercenário: escolha um dos 3 nomes mostrados no chat (digite o nome). Se errar, você morrerá.', choicesForMerc, TIME_ACTION);
    if (chosenM) {
      jogo.nightActions.mercenarioChoice = { byId: merc.userId, chosenId: chosenM };
      await dmSend(merc.userId, '✅ Escolha registrada.');
    } else {
      await dmSend(merc.userId, '⏳ Você não escolheu. Passou o turno.');
    }
  }

  /* ----- FEITICEIRA (15s) ----- */
  const feit = Array.from(jogo.players.values()).find(p => p.role === 'Feiticeira' && p.alive);
  if (feit) {
    const deadList = (jogo.dead || []).map(d => ({ id: d.id, label: d.name }));
    const aliveList = aliveTargetsAll().filter(t => t.id !== feit.userId);
    const promptParts = [];
    if (!feit.feiticeiraReviveUsed && deadList.length > 0) promptParts.push("reviver <nome>");
    if (!feit.feiticeiraPoisonUsed && jogo.nightCount >= 2) promptParts.push("envenenar <nome>");
    promptParts.push("passar");
    const prompt = `🧪 Feiticeira: você pode ${promptParts.join(' / ')}. Uma poção por rodada. Você tem ${Math.round(TIME_ACTION/1000)}s.`;
    try {
      const u = await client.users.fetch(feit.userId);
      const dm = await u.createDM();
      await dm.send(prompt);
      const filter = m => m.author.id === feit.userId;
      const collected = await dm.awaitMessages({ filter, max: 1, time: TIME_ACTION }).catch(() => null);
      if (!collected || !collected.first()) {
        await dmSend(feit.userId, '⏳ Sem ação.');
      } else {
        const txt = collected.first().content.trim();
        const lower = txt.toLowerCase();
        if (lower.startsWith('reviver ')) {
          if (feit.feiticeiraReviveUsed) {
            await dmSend(feit.userId, '❌ Você já usou a poção de reviver.');
          } else {
            const nome = txt.substring(8).trim().toLowerCase();
            const deadEntry = (jogo.dead || []).find(d => d.name.toLowerCase() === nome);
            if (!deadEntry) {
              await dmSend(feit.userId, 'Alvo inválido para reviver.');
            } else {
              jogo.nightActions.feiticeiraAction = { type: 'revive', targetId: deadEntry.id };
              feit.feiticeiraReviveUsed = true;
              jogo.feiticeiraUsedThisRound = true;
              await dmSend(feit.userId, `✨ Você escolheu reviver ${deadEntry.name}.`);
            }
          }
        } else if (lower.startsWith('envenenar ')) {
          if (jogo.nightCount < 2) {
            await dmSend(feit.userId, '❌ Veneno disponível apenas a partir da noite 2.');
          } else if (feit.feiticeiraPoisonUsed) {
            await dmSend(feit.userId, '❌ Você já usou o veneno.');
          } else if (jogo.feiticeiraUsedThisRound) {
            await dmSend(feit.userId, '❌ Apenas 1 poção por rodada.');
          } else {
            const nome = txt.substring(10).trim().toLowerCase();
            const target = Array.from(jogo.players.values()).find(p => p.username.toLowerCase() === nome && p.alive);
            if (!target) {
              await dmSend(feit.userId, 'Alvo inválido.');
            } else {
              jogo.nightActions.feiticeiraAction = { type: 'poison', targetId: target.userId };
              feit.feiticeiraPoisonUsed = true;
              jogo.feiticeiraUsedThisRound = true;
              await dmSend(feit.userId, `☠️ Você aplicou veneno em ${target.username}.`);
            }
          }
        } else {
          await dmSend(feit.userId, 'Você passou sua ação.');
        }
      }
    } catch (err) {
      console.warn('Feiticeira DM erro', err);
    }
  }

  /* ----- Agora resolver ações na ordem correta ----- */
  // provisional deaths map: id -> { byRole, note }
  const provisional = new Map();

  // 1) Assassinato
  if (jogo.nightActions.assassinTarget) {
    const t = jogo.players.get(jogo.nightActions.assassinTarget);
    if (t && t.alive && !['Assassino','Aprendiz de Assassino','Psicopata'].includes(t.role)) {
      provisional.set(t.userId, { byRole: 'Assassino', note: 'Assassino' });
    }
  }

  // 2) Psicopata outcomes
  for (const pa of jogo.nightActions.psicopataActions) {
    const t = jogo.players.get(pa.targetId);
    if (!t || !t.alive) continue;
    if (pa.resultKill) provisional.set(t.userId, { byRole: 'Psicopata', note: `Psicopata (dado ${pa.dado})` });
    else {
      // psicopata failed: nothing to add
    }
  }

  // 3) Mercenário: if chosen == true target -> kill target; else merc dies
  if (jogo.nightActions.mercenarioChoice) {
    const byId = jogo.nightActions.mercenarioChoice.byId;
    const chosenId = jogo.nightActions.mercenarioChoice.chosenId;
    if (chosenId === jogo.mercTrueTarget) {
      const t = jogo.players.get(chosenId);
      if (t && t.alive) provisional.set(chosenId, { byRole: 'Mercenário', note: 'Mercenário acerto' });
    } else {
      // merc dies
      provisional.set(byId, { byRole: 'Mercenário (falha)', note: 'Mercenário errou e morreu' });
    }
  }

  // 4) Feiticeira poison (immediate)
  if (jogo.nightActions.feiticeiraAction && jogo.nightActions.feiticeiraAction.type === 'poison') {
    const t = jogo.players.get(jogo.nightActions.feiticeiraAction.targetId);
    if (t && t.alive) provisional.set(t.userId, { byRole: 'Feiticeira (Veneno)', note: 'Veneno' });
  }

  // 5) Angel save removes from provisional
  if (jogo.anjoSave) {
    if (provisional.has(jogo.anjoSave)) {
      provisional.delete(jogo.anjoSave);
      const saved = jogo.players.get(jogo.anjoSave);
      if (saved) await canal.send(`🛡️ O Anjo salvou **${saved.username}** desta noite.`);
    }
  }

  // 6) Feiticeira revive (if chose revive, revive a dead from prior rounds or provisional)
  if (jogo.nightActions.feiticeiraAction && jogo.nightActions.feiticeiraAction.type === 'revive') {
    const reviveId = jogo.nightActions.feiticeiraAction.targetId;
    // if in dead list
    const deadEntry = (jogo.dead || []).find(d => d.id === reviveId);
    if (deadEntry) {
      // revive
      const p = jogo.players.get(reviveId);
      if (p) {
        p.alive = true;
        jogo.players.set(p.userId, p);
        jogo.dead = (jogo.dead || []).filter(d => d.id !== reviveId);
        await canal.send(`✨ A Feiticeira reviveu **${p.username}**! Cargo: **${p.role}**.`);
      }
    } else if (provisional.has(reviveId)) {
      // remove provisional kill
      provisional.delete(reviveId);
      const p = jogo.players.get(reviveId);
      if (p) await canal.send(`✨ A Feiticeira reviveu **${p.username}** após o ataque desta noite! Cargo: **${p.role}**.`);
    }
  }

  // 7) Apply provisional deaths (reveal cargos)
  if (!jogo.dead) jogo.dead = [];
  for (const [tid, info] of provisional.entries()) {
    const t = jogo.players.get(tid);
    if (!t || !t.alive) continue;
    t.alive = false;
    jogo.players.set(tid, t);
    jogo.dead.push({ id: t.userId, name: t.username, role: t.role });
    await canal.send(`💀 **${t.username}** foi morto. Cargo revelado: **${t.role}**.`);
    // if assassin died -> promote Aprendiz
    if (t.role === 'Assassino') {
      const apr = Array.from(jogo.players.values()).find(p => p.role === 'Aprendiz de Assassino' && p.alive);
      if (apr) {
        apr.role = 'Assassino';
        jogo.players.set(apr.userId, apr);
        await canal.send(`🔁 O Aprendiz de Assassino (**${apr.username}**) assumiu o papel de Assassino!`);
      }
    }
    // if Caçador died -> handle caçador immediate revenge
    if (t.role === 'Caçador') {
      await handleCacadorDeath(t.userId);
    }
  }

  // reset angel save
  jogo.anjoSave = null;
  // reset feiticeiraUsedThisRound flag
  jogo.feiticeiraUsedThisRound = false;
}

/* ---------- Votação ---------- */
async function votacaoFase() {
  if (!jogo) return;
  const canal = await client.channels.fetch(jogo.channelId);
  jogo.pendingVotes = new Map();
  // Request votes
  await canal.send('🗳️ Para votar: digite `votar nome_do_jogador` (30s). Empate => ninguém sai.');
  // collect messages in channel for TIME_VOTE
  const filter = m => !m.author.bot && m.channelId === jogo.channelId && m.content.toLowerCase().startsWith('votar ');
  const collected = await canal.awaitMessages({ filter, time: TIME_VOTE }).catch(() => null);
  if (collected && collected.size > 0) {
    for (const [id, msg] of collected) {
      const voterId = msg.author.id;
      const targetName = msg.content.substring(6).trim().toLowerCase();
      const target = Array.from(jogo.players.values()).find(p => p.username.toLowerCase() === targetName && p.alive);
      if (target) jogo.pendingVotes.set(voterId, target.userId);
    }
  }
  // tally
  const counts = new Map();
  for (const t of jogo.pendingVotes.values()) counts.set(t, (counts.get(t) || 0) + 1);
  if (counts.size === 0) {
    await canal.send('🗳️ Nenhum voto registrado. Ninguém sai.');
    return;
  }
  // find max and ties
  let max = 0; let top = null;
  for (const [k, v] of counts.entries()) {
    if (v > max) { max = v; top = k; }
  }
  const topCount = max;
  const tied = Array.from(counts.entries()).filter(([k, v]) => v === topCount).map(([k, v]) => k);
  if (tied.length > 1) {
    await canal.send('⚖️ Empate na votação. Ninguém foi eliminado.');
    return;
  }
  // candidate
  const candidate = jogo.players.get(top);
  if (!candidate) { await canal.send('Erro na votação.'); return; }
  // Aprendiz save: if candidate is mafia and aprendiz alive and hasn't used save -> DM to ask
  const mafiaRoles = ['Assassino','Psicopata','Aprendiz de Assassino'];
  const aprendiz = Array.from(jogo.players.values()).find(p => p.role === 'Aprendiz de Assassino' && p.alive && !p.usedAprendizSave);
  if (mafiaRoles.includes(candidate.role) && aprendiz) {
    try {
      const ok = await dmSend(aprendiz.userId, `⚠️ A cidade escolheu **${candidate.username}** para eliminação. Deseja salvar essa pessoa? Digite 'salvar' em ${Math.round(TIME_VOTE/1000)}s (1x).`);
      if (ok) {
        const dm = await (await client.users.fetch(aprendiz.userId)).createDM();
        const filter = m => m.author.id === aprendiz.userId;
        const collectedApr = await dm.awaitMessages({ filter, max: 1, time: TIME_VOTE }).catch(() => null);
        if (collectedApr && collectedApr.first() && collectedApr.first().content.toLowerCase().includes('salvar')) {
          aprendiz.usedAprendizSave = true;
          jogo.players.set(aprendiz.userId, aprendiz);
          await canal.send(`🛡️ O Aprendiz de Assassino salvou **${candidate.username}** da eliminação!`);
          return;
        }
      }
    } catch (err) {
      console.warn('Erro DM aprendiz during vote', err);
    }
  }
  // eliminate
  candidate.alive = false;
  jogo.players.set(candidate.userId, candidate);
  jogo.dead = jogo.dead || [];
  jogo.dead.push({ id: candidate.userId, name: candidate.username, role: candidate.role });
  await canal.send(`🗳️ Pela votação, **${candidate.username}** foi eliminado. Cargo revelado: **${candidate.role}**.`);
  if (candidate.role === 'Assassino') {
    const apr = Array.from(jogo.players.values()).find(p => p.role === 'Aprendiz de Assassino' && p.alive);
    if (apr) {
      apr.role = 'Assassino';
      jogo.players.set(apr.userId, apr);
      await canal.send(`🔁 O Aprendiz de Assassino (**${apr.username}**) assumiu o papel de Assassino!`);
    }
  }
  if (candidate.role === 'Caçador') {
    await handleCacadorDeath(candidate.userId);
  }
}

/* ---------- Caçador ao morrer ---------- */
async function handleCacadorDeath(deadId) {
  const p = jogo.players.get(deadId);
  if (!p) return;
  try {
    const u = await client.users.fetch(deadId);
    const dm = await u.createDM();
    await dm.send('Você morreu. Como Caçador, você pode escolher um jogador para matar em 10s. Responda: matar <nome>');
    const filter = m => m.author.id === deadId;
    const collected = await dm.awaitMessages({ filter, max: 1, time: TIME_CACADOR }).catch(() => null);
    if (collected && collected.first()) {
      const txt = collected.first().content.trim();
      if (txt.toLowerCase().startsWith('matar ')) {
        const targetName = txt.substring(6).trim().toLowerCase();
        const target = Array.from(jogo.players.values()).find(x => x.username.toLowerCase() === targetName && x.alive);
        if (target) {
          target.alive = false;
          jogo.players.set(target.userId, target);
          jogo.dead = jogo.dead || [];
          jogo.dead.push({ id: target.userId, name: target.username, role: target.role });
          const canal = await client.channels.fetch(jogo.channelId);
          await canal.send(`🏹 O Caçador (**${p.username}**) matou **${target.username}** antes de morrer. Cargo revelado: **${target.role}**.`);
          return;
        } else {
          await dm.send('Alvo inválido ou já morto. Poder perdido.');
          return;
        }
      } else {
        await dm.send('Formato inválido. Poder perdido.');
        return;
      }
    } else {
      await dm.send('Tempo esgotado. Poder perdido.');
      return;
    }
  } catch (err) {
    console.warn('handleCacadorDeath erro', err);
  }
}

/* ---------- Checagem de vitória ---------- */
function verificarVitoria(canal) {
  const vivos = Array.from(jogo.players.values()).filter(p => p.alive);
  const mafiasAlive = vivos.filter(p => ['Assassino','Psicopata','Aprendiz de Assassino'].includes(p.role)).length;
  const civisAlive = vivos.length - mafiasAlive;
  if (mafiasAlive === 0) {
    canal.send('🏆 Cidade vence! Todas as máfias foram eliminadas.');
    jogo = null;
    return true;
  }
  if (mafiasAlive >= 1 && civisAlive <= 2) {
    canal.send(`🏆 Máfia vence! Restam ${mafiasAlive} máfias e ${civisAlive} civis.`);
    jogo = null;
    return true;
  }
  return false;
}

/* ---------- Mensagens de erro/controle e login ---------- */
client.on('error', console.error);
client.login(TOKEN);


      await user.send('Tempo esgotado. Poder perdido.');
    }
  } catch (err) {
    console.warn('handleCacadorDeath erro', err);
  }
}
