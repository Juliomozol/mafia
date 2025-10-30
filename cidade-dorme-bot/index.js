// ==== BOT CIDADE DORME ====
// Linguagem: JavaScript (Node.js)
// Discord.js v14+

require("dotenv").config();
const { Client, GatewayIntentBits } = require("discord.js");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

client.once("ready", () => {
  console.log(`🤖 Logado como ${client.user.tag}`);
});

client.login(process.env.TOKEN);


const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  SlashCommandBuilder, 
  Collection, 
  Events 
} = require('discord.js');
require('dotenv').config();

// ===== CONFIGURAÇÕES DO BOT =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// ===== VARIÁVEIS DE JOGO =====
let jogadores = new Map(); // userId => username
let jogoIniciado = false;

const cargos = {
  civis: ["Vidente", "Anjo", "Feiticeira", "Caçador", "Ladrão de Túmulos", "Prefeito"],
  mafia: ["Assassino", "Psicopata", "Aprendiz de Assassino", "Mercenário"],
  solo: ["Bobo da Corte"]
};

// ===== COMANDO /cidade =====
client.once(Events.ClientReady, () => {
  console.log(`🤖 Logado como ${client.user.tag}`);
  client.application.commands.create(
    new SlashCommandBuilder()
      .setName('cidade')
      .setDescription('Inicia o lobby do jogo Cidade Dorme.')
  );
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'cidade') return;

  if (jogoIniciado)
    return interaction.reply({ content: '🚫 O jogo já está em andamento!', ephemeral: true });

  jogadores.clear();

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('entrar')
      .setLabel('🎮 Entrar no Jogo')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('iniciar')
      .setLabel('🚀 Iniciar Jogo (Admin)')
      .setStyle(ButtonStyle.Danger)
  );

  await interaction.reply({
    content: '🎯 Clique em **Entrar no Jogo** para participar!\nQuando todos entrarem, um admin deve clicar em **Iniciar Jogo**.',
    components: [row]
  });
});

// ===== BOTÕES =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const member = interaction.member;
  const user = interaction.user;

  if (interaction.customId === 'entrar') {
    if (jogoIniciado) {
      return interaction.reply({ content: '⏳ O jogo já começou!', ephemeral: true });
    }

    if (jogadores.has(user.id)) {
      return interaction.reply({ content: '⚠️ Você já entrou no jogo!', ephemeral: true });
    }

    jogadores.set(user.id, user.username);
    await interaction.reply({ content: `✅ ${user.username} entrou no jogo! (${jogadores.size} jogadores)`, ephemeral: true });
  }

  if (interaction.customId === 'iniciar') {
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ content: '🚫 Apenas administradores podem iniciar o jogo.', ephemeral: true });
    }

    if (jogadores.size < 5) {
      return interaction.reply({ content: '⚠️ O jogo precisa de pelo menos **5 jogadores**!', ephemeral: true });
    }

    jogoIniciado = true;
    await interaction.reply('🎬 O jogo começou! Enviando cargos via DM...');

    await distribuirCargos(interaction.channel);
  }
});

// ===== FUNÇÃO: DISTRIBUIR CARGOS =====
async function distribuirCargos(canal) {
  const todosCargos = [...cargos.civis, ...cargos.mafia, ...cargos.solo];
  const mistura = shuffleArray(todosCargos);
  const jogadoresArray = Array.from(jogadores.entries());
  const distribuicao = {};

  for (let i = 0; i < jogadoresArray.length; i++) {
    const [id, nome] = jogadoresArray[i];
    const cargo = mistura[i] || 'Civil Comum';
    distribuicao[nome] = cargo;

    try {
      const user = await client.users.fetch(id);
      await user.send(`🎭 **Seu cargo é:** ${cargo}`);
    } catch (err) {
      console.log(`❌ Erro ao enviar DM para ${nome}`);
      await canal.send(`⚠️ ${nome}, habilite suas DMs para receber o cargo!`);
    }
  }

  await canal.send('✅ Todos os cargos foram enviados!');
  await iniciarJogo(canal, distribuicao);
}

// ===== FUNÇÃO: INICIAR JOGO =====
async function iniciarJogo(canal, distribuicao) {
  let rodada = 1;
  const vivos = Object.keys(distribuicao);

  while (vivos.length > 2) {
    await canal.send(`🌙 **Noite ${rodada}** começou!`);
    await esperar(10000);
    await canal.send('💀 Máfias estão agindo...');
    await esperar(8000);

    await canal.send('🧙 Feiticeira, sua vez...');
    await esperar(8000);

    await canal.send('🔧 Inventor, se manifeste...');
    await esperar(8000);

    await canal.send(`🌞 **Dia ${rodada}** amanheceu!`);
    await iniciarVotacao(canal, vivos);

    rodada++;
    if (rodada > 5) break; // limite simples
  }

  canal.send('🏁 O jogo terminou!');
  jogoIniciado = false;
  jogadores.clear();
}

// ===== FUNÇÃO: VOTAÇÃO =====
async function iniciarVotacao(canal, vivos) {
  const msg = await canal.send('🗳️ **Votação aberta!** Escolham quem será eliminado.');
  for (const nome of vivos) await msg.react('✅');
  await esperar(15000);
  await canal.send('🧾 **Votação encerrada!**');
}

// ===== FUNÇÃO AUXILIAR =====
function shuffleArray(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function esperar(ms) {
  return new Promise(res => setTimeout(res, ms));
}

// ===== LOGIN =====
client.login(process.env.TOKEN);
