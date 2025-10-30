require('dotenv').config();
const { 
  Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  Events, SlashCommandBuilder, REST, Routes 
} = require('discord.js');

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

function shuffle(arr) { return arr.sort(() => Math.random() - 0.5); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function mention(id) { return `<@${id}>`; }

let lobby = new Map(); // userId -> username
let jogo = null; // estado do jogo
async function dmSend(userId, content) {
  try {
    const u = await client.users.fetch(userId);
    await u.send(content);
    return true;
  } catch { return false; }
}

async function solicitarEscolhaDM(userId, promptText, validTargets, time = 15000) {
  try {
    const u = await client.users.fetch(userId);
    const dm = await u.createDM();
    let listText = validTargets.map(t => `- ${t.label}`).join('\n');
    await dm.send(`${promptText}\nAlvos:\n${listText}\nDigite o NOME exato do jogador ou 'passar'. Você tem ${time/1000}s.`);
    const filter = m => m.author.id === userId;
    const collected = await dm.awaitMessages({ filter, max: 1, time, errors: ['time'] }).catch(() => null);
    if (!collected || !collected.first()) return null;
    const reply = collected.first().content.trim().toLowerCase();
    if (reply === 'passar') return null;
    const match = validTargets.find(t => t.label.toLowerCase() === reply || t.id === reply);
    return match ? match.id : null;
  } catch { return null; }
}

function findAliveRole(role) {
  if (!jogo) return null;
  return Array.from(jogo.players.values()).find(p => p.role === role && p.alive) || null;
}

function alivePlayersList() {
  if (!jogo) return [];
  return Array.from(jogo.players.values()).filter(p => p.alive);
}

function aliveTargetsAll() {
  return alivePlayersList().map(p => ({ id: p.userId, label: p.username }));
}

function aliveTargetsForMafia() {
  return alivePlayersList().filter(p => !['Assassino','Aprendiz de Assassino','Psicopata'].includes(p.role))
    .map(p => ({ id: p.userId, label: p.username }));
}

client.once(Events.ClientReady, async () => {
  console.log('Bot online:', client.user.tag);
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const cmd = new SlashCommandBuilder().setName('cidade').setDescription('Abre o lobby do jogo Cidade Dorme').toJSON();
  await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: [cmd] });
  console.log('Comando /cidade registrado.');
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'cidade') {
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Apenas admins podem abrir o lobby.', flags: InteractionResponseFlags.Ephemeral });
      if (jogo) return interaction.reply({ content: 'Já existe um jogo em andamento.', flags: InteractionResponseFlags.Ephemeral });

      lobby.clear();
      const entrarBtn = new ButtonBuilder().setCustomId('entrar_lobby').setLabel('🎮 Entrar no Jogo').setStyle(ButtonStyle.Success);
      const iniciarBtn = new ButtonBuilder().setCustomId('iniciar_jogo').setLabel('🚀 Iniciar Jogo (Admin)').setStyle(ButtonStyle.Danger);
      const row = new ActionRowBuilder().addComponents(entrarBtn, iniciarBtn);

      await interaction.reply({ content: '**LOBBY** — Clique em Entrar para participar. Quando todos entrarem, um admin deve clicar em Iniciar.', components: [row] });
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'entrar_lobby') {
        if (jogo) return interaction.reply({ content: '⏳ Jogo já começou', flags: InteractionResponseFlags.Ephemeral });
        if (lobby.has(interaction.user.id)) return interaction.reply({ content: 'Você já entrou no lobby.', flags: InteractionResponseFlags.Ephemeral });
        lobby.set(interaction.user.id, interaction.user.username);
        return interaction.reply({ content: `✅ ${interaction.user.username} entrou no lobby! (${lobby.size})`, ephemeral: true });
      }
      if (interaction.customId === 'iniciar_jogo') {
        if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Apenas admins podem iniciar.', flags: InteractionResponseFlags.Ephemeral });
        if (jogo) return interaction.reply({ content: 'Jogo já em andamento.', flags: InteractionResponseFlags.Ephemeral });
        if (lobby.size < 5) return interaction.reply({ content: 'Mínimo 5 jogadores para iniciar.', flags: InteractionResponseFlags.Ephemeral });

        await interaction.reply({ content: '🎲 Iniciando o jogo... enviando cargos via DM.', flags: InteractionResponseFlags.Ephemeral });
        const channel = await client.channels.fetch(CHANNEL_ID);
        iniciarPartida(channel);
        return;
      }
    }
  } catch (err) { console.error(err); }
});
async function iniciarPartida(channel) {
  jogo = {
    channelId: CHANNEL_ID,
    players: new Map(),
    round: 0,
    nightCount: 0,
    dead: [],
    anjoSave: null,
    mercTrueTarget: null,
    feiticeiraUsedThisRound: false
  };

  const playerIds = Array.from(lobby.keys());

  // Papéis obrigatórios
  const mandatory = ['Assassino','Aprendiz de Assassino','Psicopata','Feiticeira','Anjo','Vidente','Caçador'];
  let roles = [...mandatory];
  while (roles.length < playerIds.length) roles.push('Civil'); // atribuindo Civil
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

  // Enviar cargos por DM
  for (const [id, p] of jogo.players) {
    const ok = await dmSend(id, `🎭 Seu cargo: **${p.role}**`);
    if (!ok) await channel.send(`⚠️ ${p.username}, habilite DMs para receber seu cargo.`);
  }

  // Revelar Caçador publicamente
  const cacador = findAliveRole('Caçador');
  if (cacador) await channel.send(`🔍 O Caçador foi revelado: **${cacador.username}**.`);
  
  lobby.clear();
  mainLoop().catch(console.error);
}
async function mainLoop() {
  const channel = await client.channels.fetch(CHANNEL_ID);

  while (true) {
    jogo.round++;
    await channel.send(`🌙 **Noite ${jogo.round}** começa!`);
    await sleep(3000);

    // Reset night actions
    jogo.anjoSave = null;
    jogo.feiticeiraUsedThisRound = false;

    await nightPhase(channel);
    const someoneDead = processDeaths(channel);
    if (checkVictory(channel)) break;

    await dayPhase(channel);
    if (checkVictory(channel)) break;
  }
}
async function nightPhase(channel) {
  // MÁFIA
  const mafiaTargets = aliveTargetsForMafia();
  const assassino = findAliveRole('Assassino');
  const psicopata = findAliveRole('Psicopata');
  const aprendiz = findAliveRole('Aprendiz de Assassino');

  let assassinTarget = null;
  if (assassino) assassinTarget = await solicitarEscolhaDM(assassino.userId, 'Escolha alguém para eliminar:', mafiaTargets);
  
  // Psicopata tem chance de atacar sozinho
  let psicopataTarget = null;
  if (psicopata) psicopataTarget = await solicitarEscolhaDM(psicopata.userId, 'Escolha alguém para eliminar:', mafiaTargets);

  // Aprendiz de Assassino pode salvar um aliado
  if (aprendiz && assassinTarget) {
    const salvar = await solicitarEscolhaDM(aprendiz.userId, `Deseja salvar ${jogo.players.get(assassinTarget).username}? Digite 'sim' ou 'não'.`, [{id:'sim',label:'sim'},{id:'nao',label:'não'}]);
    if (salvar === 'sim') assassinTarget = null;
  }

  // Anjo
  const anjo = findAliveRole('Anjo');
  if (anjo) jogo.anjoSave = await solicitarEscolhaDM(anjo.userId, 'Escolha alguém para proteger esta noite:', aliveTargetsAll());

  // Feiticeira
  const feiticeira = findAliveRole('Feiticeira');
  if (feiticeira && !jogo.feiticeiraUsedThisRound) {
    const revive = await solicitarEscolhaDM(feiticeira.userId, 'Deseja usar poção de reviver? Alvo:', jogo.dead.map(d => ({id:d.userId,label:d.username})));
    const poison = await solicitarEscolhaDM(feiticeira.userId, 'Deseja usar poção de veneno? Alvo:', aliveTargetsAll());
    if (revive) {
      const target = jogo.players.get(revive);
      target.alive = true;
      jogo.dead = jogo.dead.filter(d => d.userId !== revive);
      await channel.send(`✨ Feiticeira reviveu ${target.username}`);
      jogo.feiticeiraUsedThisRound = true;
    }
    if (poison) {
      const target = jogo.players.get(poison);
      target.alive = false;
      jogo.dead.push({userId: target.userId, username: target.username, role: target.role});
      await channel.send(`☠️ Feiticeira envenenou ${target.username}`);
      jogo.feiticeiraUsedThisRound = true;
    }
  }

  // Registrar mortes da noite
  const nightKills = [assassinTarget, psicopataTarget].filter(Boolean);
  for (let uid of nightKills) {
    if (jogo.anjoSave === uid) continue; // protegido pelo anjo
    const target = jogo.players.get(uid);
    target.alive = false;
    jogo.dead.push({userId: target.userId, username: target.username, role: target.role});
    await channel.send(`💀 ${target.username} foi morto durante a noite.`);
  }

  await sleep(2000);
}function processDeaths(channel) {
  if (!jogo.dead.length) return false;

  for (const dead of jogo.dead) {
    const player = jogo.players.get(dead.userId);
    if (!player) continue;
    // Caçador
    if (player.role === 'Caçador' && player.alive === false) {
      // Pode matar alguém antes de morrer
      // (Para simplificação, pode ser implementado DM ou votação)
    }
  }
  return true;
}async function dayPhase(channel) {
  await channel.send(`☀️ **Dia ${jogo.round}** começou! Discussão e votação.`);

  // Listar jogadores vivos
  const aliveList = alivePlayersList().map(p => p.username).join(', ');
  await channel.send(`Jogadores vivos: ${aliveList}`);

  // Coletar votos (simplificado: votação via DM ou canal)
  // Aqui podemos expandir para botão ou comando /votar
  await sleep(15000); // placeholder discussão
  await channel.send('⏳ Fim do tempo de votação (votação ainda não implementada em bot).');
}function checkVictory(channel) {
  const alive = alivePlayersList();
  const mafia = alive.filter(p => ['Assassino','Aprendiz de Assassino','Psicopata'].includes(p.role));
  const civis = alive.filter(p => !['Assassino','Aprendiz de Assassino','Psicopata'].includes(p.role));

  if (mafia.length === 0) {
    channel.send('🏆 Civis venceram! Todos os mafiosos foram eliminados.');
    jogo = null; return true;
  }

  if (mafia.length >= civis.length) {
    channel.send('🏴‍☠️ Mafiosos venceram! Eles dominaram a cidade.');
    jogo = null; return true;
  }

  return false;
}
client.login(TOKEN);
