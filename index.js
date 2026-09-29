require("dotenv").config();

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const {
    Client,
    GatewayIntentBits,
    Partials,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionFlagsBits,
    EmbedBuilder,
    ChannelType,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require("discord.js");

// ==========================================================
// PROFESSIONAL GRASS 🌱
// ==========================================================

const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const OWNER_ID = process.env.OWNER_ID;
const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI;
const PRIVACY_URL = process.env.PRIVACY_URL || null;
const PORT = process.env.PORT || 3000;

for (const [key, value] of Object.entries({
    BOT_TOKEN: TOKEN,
    CLIENT_ID,
    CLIENT_SECRET,
    OWNER_ID,
    OAUTH_REDIRECT_URI
})) {
    if (!value) {
        console.error(`❌ Missing required env var: ${key}`);
        process.exit(1);
    }
}

// ==========================================================
// DATABASE
// ==========================================================

const DATA_FOLDER = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_FOLDER, "database.json");

const DEFAULT_DATABASE = {
    guilds: {},
    leakServers: {},
    whitelists: {},
    detections: [],
    // userId -> { username, matches: [{id, name}], checkedAt }
    verifications: {}
};

function cloneDefaultDatabase() {
    return JSON.parse(JSON.stringify(DEFAULT_DATABASE));
}

function ensureDataFolder() {
    if (!fs.existsSync(DATA_FOLDER)) {
        fs.mkdirSync(DATA_FOLDER, { recursive: true });
    }
}

function saveDatabase() {
    ensureDataFolder();
    try {
        const temp = `${DATA_FILE}.tmp`;
        fs.writeFileSync(temp, JSON.stringify(database, null, 2), "utf8");
        fs.renameSync(temp, DATA_FILE);
    } catch (error) {
        console.error("❌ Database save failed:", error);
    }
}

function loadDatabase() {
    ensureDataFolder();
    if (!fs.existsSync(DATA_FILE)) return cloneDefaultDatabase();

    try {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        data.guilds ??= {};
        data.leakServers ??= {};
        data.whitelists ??= {};
        data.detections ??= [];
        data.verifications ??= {};
        return data;
    } catch (error) {
        console.error("❌ Database load failed:", error);
        return cloneDefaultDatabase();
    }
}

let database = loadDatabase();
saveDatabase();

// ==========================================================
// DISCORD CLIENT
// ==========================================================

const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
    partials: [Partials.GuildMember]
});

// ==========================================================
// SERVER CONFIGURATION
// ==========================================================

function getGuildConfig(guildId) {
    return database.guilds[guildId] || null;
}

function createGuildConfig(guildId) {
    if (!database.guilds[guildId]) {
        database.guilds[guildId] = {
            alertChannelId: null,
            staffRoleId: null,
            verifiedRoleId: null,
            autoScan: true,
            configuredAt: null
        };
        saveDatabase();
    }
    return database.guilds[guildId];
}

function deleteGuildConfig(guildId) {
    delete database.guilds[guildId];
    delete database.whitelists[guildId];
    saveDatabase();
}

// ==========================================================
// WHITELIST
// ==========================================================

function isWhitelisted(guildId, userId) {
    return (database.whitelists[guildId] || []).includes(userId);
}

function addToWhitelist(guildId, userId) {
    database.whitelists[guildId] ??= [];
    if (!database.whitelists[guildId].includes(userId)) {
        database.whitelists[guildId].push(userId);
        saveDatabase();
    }
}

function removeFromWhitelist(guildId, userId) {
    database.whitelists[guildId] = (database.whitelists[guildId] || []).filter(
        id => id !== userId
    );
    saveDatabase();
}

// ==========================================================
// PERMISSIONS
// ==========================================================

function isBotOwner(userId) {
    return userId === OWNER_ID;
}

function isStaff(interaction) {
    if (isBotOwner(interaction.user.id)) return true;
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;

    const config = getGuildConfig(interaction.guildId);
    if (!config?.staffRoleId) return false;

    return interaction.member?.roles?.cache?.has(config.staffRoleId) || false;
}

// ==========================================================
// EMBEDS
// ==========================================================

function baseEmbed() {
    return new EmbedBuilder()
        .setColor(0x46a758)
        .setFooter({ text: "Professional Grass 🌱 • The grass never forgets." })
        .setTimestamp();
}

function successEmbed(title, description) {
    return baseEmbed().setTitle(`🌱 ${title}`).setDescription(description);
}

function errorEmbed(description) {
    return baseEmbed()
        .setColor(0xed4245)
        .setTitle("❌ Professional Grass")
        .setDescription(description);
}

function matchEmbed(user, matches) {
    const serverText = matches.map(match => `🚨 **${match.name}**`).join("\n");

    return baseEmbed()
        .setColor(0xed4245)
        .setTitle("🚨 PROFESSIONAL GRASS ALERT")
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setDescription(
            `🐀 **CAUGHT TOUCHING THE WRONG GRASS**\n\n` +
            `👤 **User:** ${user}\n` +
            `🆔 **User ID:** \`${user.id}\`\n\n` +
            `**Known leak-server match(es):**\n${serverText}\n\n` +
            `🌱 *The grass never forgets.*`
        );
}

function clearEmbed(user) {
    return baseEmbed()
        .setTitle("🔎 PROFESSIONAL GRASS CHECK")
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setDescription(
            `👤 **User:** ${user}\n` +
            `🆔 **User ID:** \`${user.id}\`\n\n` +
            `✅ Verified, and no matches were found on the known-server list.\n\n` +
            `🌱 *The lawn is looking clean.*`
        );
}

function unverifiedEmbed(user) {
    return baseEmbed()
        .setColor(0xfee75c)
        .setTitle("⚪ NOT VERIFIED")
        .setThumbnail(user.displayAvatarURL({ size: 256 }))
        .setDescription(
            `👤 **User:** ${user}\n` +
            `🆔 **User ID:** \`${user.id}\`\n\n` +
            `This member hasn't verified yet, so Professional Grass can't say either way.\n` +
            `Ask them to press **Verify** on the verification panel.\n\n` +
            `🌱 *Unchecked grass is still grass.*`
        );
}

// ==========================================================
// VERIFICATION (OAUTH) — checks members without the bot
// joining the leak servers
// ==========================================================

const pendingStates = new Map(); // state -> { userId, guildId, expires }

setInterval(() => {
    const now = Date.now();
    for (const [key, value] of pendingStates) {
        if (value.expires < now) pendingStates.delete(key);
    }
}, 5 * 60 * 1000);

function buildAuthUrl(userId, guildId) {
    const state = crypto.randomBytes(16).toString("hex");
    pendingStates.set(state, {
        userId,
        guildId,
        expires: Date.now() + 10 * 60 * 1000
    });

    const params = new URLSearchParams({
        client_id: CLIENT_ID,
        response_type: "code",
        redirect_uri: OAUTH_REDIRECT_URI,
        scope: "identify guilds",
        state
    });

    return `https://discord.com/oauth2/authorize?${params}`;
}

async function runVerification(code, state) {
    const entry = pendingStates.get(state);
    pendingStates.delete(state);

    if (!entry || entry.expires < Date.now()) {
        throw new Error("This link expired. Go back to Discord and press Verify again.");
    }

    const tokenRes = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: "authorization_code",
            code,
            redirect_uri: OAUTH_REDIRECT_URI
        })
    });

    if (!tokenRes.ok) throw new Error("Discord rejected the authorization. Try again.");

    const { access_token } = await tokenRes.json();
    const headers = { Authorization: `Bearer ${access_token}` };

    try {
        const meRes = await fetch("https://discord.com/api/v10/users/@me", { headers });
        if (!meRes.ok) throw new Error("Could not read your account.");
        const me = await meRes.json();

        if (me.id !== entry.userId) {
            throw new Error("Account mismatch. Authorize with the same Discord account you clicked the button with.");
        }

        const guilds = [];
        let after;
        while (true) {
            const url = new URL("https://discord.com/api/v10/users/@me/guilds");
            url.searchParams.set("limit", "200");
            if (after) url.searchParams.set("after", after);

            const res = await fetch(url, { headers });
            if (!res.ok) throw new Error("Could not read your server list.");

            const batch = await res.json();
            if (!Array.isArray(batch)) break;

            guilds.push(...batch);
            if (batch.length < 200) break;
            after = batch[batch.length - 1].id;
        }

        // Only matches are kept. The full server list is thrown away.
        const matches = guilds
            .filter(g => database.leakServers[g.id])
            .map(g => ({
                id: g.id,
                name: database.leakServers[g.id].name || g.name
            }));

        database.verifications[me.id] = {
            username: me.username,
            matches,
            checkedAt: Date.now()
        };
        saveDatabase();

        return { userId: me.id, guildId: entry.guildId, matches };
    } finally {
        // Never keep the user's token
        fetch("https://discord.com/api/v10/oauth2/token/revoke", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                token: access_token
            })
        }).catch(() => {});
    }
}

async function afterVerification(guildId, userId, matches) {
    try {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return;

        const config = getGuildConfig(guildId);
        if (!config) return;
        if (isWhitelisted(guildId, userId)) return;

        if (matches.length) {
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) return;

            saveDetection(guildId, userId, matches);
            await sendDetectionAlert(guild, user, matches);
            return;
        }

        if (config.verifiedRoleId) {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (member) {
                await member.roles.add(config.verifiedRoleId).catch(error =>
                    console.error(`Verified role failed in ${guild.name}:`, error.message)
                );
            }
        }
    } catch (error) {
        console.error("afterVerification failed:", error);
    }
}

function isVerified(userId) {
    return Boolean(database.verifications[userId]);
}

// ==========================================================
// HTTP SERVER (OAuth callback)
// ==========================================================

const esc = s =>
    String(s).replace(/[&<>"']/g, c => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    }[c]));

const htmlPage = (title, body) =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${esc(title)}</title>` +
    `<body style="font-family:system-ui,sans-serif;background:#1e1f22;color:#f2f3f5;display:grid;place-items:center;min-height:100vh;margin:0">` +
    `<div style="text-align:center;padding:2rem;max-width:32rem"><h1>${esc(title)}</h1><p>${body}</p></div></body>`;

http
    .createServer(async (req, res) => {
        const url = new URL(req.url, "http://localhost");

        if (url.pathname === "/callback") {
            try {
                const code = url.searchParams.get("code");
                const state = url.searchParams.get("state");
                if (!code || !state) throw new Error("Authorization was cancelled or incomplete.");

                const { userId, guildId, matches } = await runVerification(code, state);
                afterVerification(guildId, userId, matches);

                res.writeHead(200, { "Content-Type": "text/html" });
                return res.end(htmlPage("Verified 🌱", "You can close this tab and return to Discord."));
            } catch (error) {
                res.writeHead(400, { "Content-Type": "text/html" });
                return res.end(htmlPage("Verification failed", esc(error.message)));
            }
        }

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Professional Grass is alive 🌱");
    })
    .listen(PORT, "0.0.0.0", () => {
        console.log(`🌐 HTTP server listening on ${PORT}`);
        console.log(`🌐 OAuth callback path: /callback`);
    });


// ==========================================================
// LEAK SERVER CHECKING
// ==========================================================

/*
   A member matches if:
   1. They verified and were found in a server on the central list, OR
   2. (legacy) The bot happens to be in a listed server and can see them.
   The bot does NOT need to be in the listed servers for (1).
*/
async function checkUserAgainstLeakServers(userId) {
    const matches = new Map();

    // 1. From the member's verification
    const record = database.verifications[userId];
    if (record) {
        for (const match of record.matches || []) {
            const info = database.leakServers[match.id];
            if (!info) continue; // server was removed from the list
            matches.set(match.id, { id: match.id, name: info.name || match.name });
        }
    }

    // 2. Servers the bot is already inside (optional bonus)
    for (const [guildId, info] of Object.entries(database.leakServers)) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) continue;

        try {
            let member = guild.members.cache.get(userId);
            if (!member) {
                member = await guild.members.fetch(userId).catch(() => null);
            }
            if (member) {
                matches.set(guildId, { id: guildId, name: info.name || guild.name });
            }
        } catch (error) {
            console.error(`Check failed for ${userId} in ${guildId}:`, error.message);
        }
    }

    return [...matches.values()];
}

// ==========================================================
// DETECTIONS
// ==========================================================

function saveDetection(protectedGuildId, userId, matches) {
    database.detections.push({
        protectedGuildId,
        userId,
        matches: matches.map(match => ({ id: match.id, name: match.name })),
        detectedAt: new Date().toISOString()
    });

    if (database.detections.length > 5000) {
        database.detections = database.detections.slice(-5000);
    }

    saveDatabase();
}

// ==========================================================
// ALERT CHANNEL
// ==========================================================

async function sendDetectionAlert(protectedGuild, user, matches) {
    const config = getGuildConfig(protectedGuild.id);
    if (!config?.alertChannelId) return;

    try {
        const channel =
            protectedGuild.channels.cache.get(config.alertChannelId) ||
            (await protectedGuild.channels.fetch(config.alertChannelId));

        if (!channel || !channel.isTextBased()) return;

        await channel.send({ embeds: [matchEmbed(user, matches)] });
    } catch (error) {
        console.error(`Couldn't send alert in ${protectedGuild.name}:`, error.message);
    }
}

// ==========================================================
// COMMAND DEFINITIONS
// ==========================================================

const commandBuilders = [
    new SlashCommandBuilder()
        .setName("setup")
        .setDescription("Set up Professional Grass in this server.")
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addChannelOption(o =>
            o
                .setName("alert_channel")
                .setDescription("Where leaker alerts should be sent.")
                .addChannelTypes(ChannelType.GuildText)
                .setRequired(true)
        )
        .addRoleOption(o =>
            o.setName("staff_role").setDescription("Role allowed to use staff commands.").setRequired(false)
        )
        .addRoleOption(o =>
            o
                .setName("verified_role")
                .setDescription("Role given to members who verify with no matches.")
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName("verifypanel")
        .setDescription("Post the member verification panel in this channel."),

    new SlashCommandBuilder()
        .setName("settings")
        .setDescription("View this server's Professional Grass settings."),

    new SlashCommandBuilder()
        .setName("autoscan")
        .setDescription("Enable or disable automatic join checks.")
        .addBooleanOption(o =>
            o.setName("enabled").setDescription("Should new members be checked?").setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName("check")
        .setDescription("Check one member for known server matches.")
        .addUserOption(o => o.setName("user").setDescription("The member to check.").setRequired(true)),

    new SlashCommandBuilder().setName("scan").setDescription("Scan members of this server."),

    new SlashCommandBuilder()
        .setName("whitelist")
        .setDescription("Ignore a member in future checks.")
        .addUserOption(o => o.setName("user").setDescription("Member to whitelist.").setRequired(true)),

    new SlashCommandBuilder()
        .setName("unwhitelist")
        .setDescription("Remove a member from the whitelist.")
        .addUserOption(o => o.setName("user").setDescription("Member to remove.").setRequired(true)),

    new SlashCommandBuilder().setName("stats").setDescription("Show Professional Grass statistics."),

    new SlashCommandBuilder()
        .setName("mydata")
        .setDescription("See or delete what Professional Grass stored about you.")
        .addSubcommand(s => s.setName("view").setDescription("Show your stored verification result."))
        .addSubcommand(s => s.setName("delete").setDescription("Delete your stored verification result.")),

    new SlashCommandBuilder()
        .setName("leakserver")
        .setDescription("Manage the central known-server list. (Bot owner only)")
        .addSubcommand(s =>
            s
                .setName("add")
                .setDescription("Add a server. Give an invite link OR a server ID. The bot does NOT join it.")
                .addStringOption(o =>
                    o.setName("invite").setDescription("Invite link or code for the server.").setRequired(false)
                )
                .addStringOption(o =>
                    o.setName("server_id").setDescription("Discord server ID.").setRequired(false)
                )
                .addStringOption(o =>
                    o.setName("name").setDescription("Name shown in alerts.").setRequired(false)
                )
        )
        .addSubcommand(s =>
            s
                .setName("remove")
                .setDescription("Remove a server from the list.")
                .addStringOption(o =>
                    o.setName("server_id").setDescription("Discord server ID.").setRequired(true)
                )
        )
        .addSubcommand(s => s.setName("list").setDescription("Show the known server list."))
];

const commands = commandBuilders.map(c => c.toJSON());

async function registerCommands() {
    const rest = new REST({ version: "10" }).setToken(TOKEN);
    console.log("🌱 Registering global app commands...");
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    console.log("✅ Global app commands registered.");
}

// ==========================================================
// READY
// ==========================================================

client.once("ready", () => {
    console.log("\n==========================================");
    console.log("🌱 PROFESSIONAL GRASS ONLINE");
    console.log("==========================================");
    console.log(`Logged in: ${client.user.tag}`);
    console.log(`Installed servers: ${client.guilds.cache.size}`);
    console.log(`Configured servers: ${Object.keys(database.guilds).length}`);
    console.log(`Known leak servers: ${Object.keys(database.leakServers).length}`);
    console.log(`Verified users: ${Object.keys(database.verifications).length}`);
    console.log("==========================================\n");

    client.user.setActivity("for dodgy grass 🌱");
});

client.on("guildCreate", guild => {
    createGuildConfig(guild.id);
    console.log(`➕ Installed in: ${guild.name} (${guild.id})`);
});

client.on("guildDelete", guild => {
    deleteGuildConfig(guild.id);
    console.log(`➖ Removed from: ${guild.name} (${guild.id})`);
});

// ==========================================================
// AUTOMATIC NEW-MEMBER CHECK
// Works for anyone who has already verified (in any server
// using the bot). Unverified members can't be checked until
// they press Verify.
// ==========================================================

client.on("guildMemberAdd", async member => {
    try {
        if (member.user.bot) return;

        const config = getGuildConfig(member.guild.id);
        if (!config || !config.autoScan) return;
        if (isWhitelisted(member.guild.id, member.id)) return;

        const matches = await checkUserAgainstLeakServers(member.id);
        if (!matches.length) return;

        saveDetection(member.guild.id, member.id, matches);
        await sendDetectionAlert(member.guild, member.user, matches);
    } catch (error) {
        console.error("Join check failed:", error);
    }
});

// ==========================================================
// INTERACTIONS
// ==========================================================

client.on("interactionCreate", async interaction => {
    // ------------------------------------------------------
    // Verify button
    // ------------------------------------------------------
    if (interaction.isButton() && interaction.customId === "grass_verify") {
        if (!interaction.guild) return;

        if (!Object.keys(database.leakServers).length) {
            return interaction.reply({
                content: "🌱 Verification isn't set up yet. Ask the server staff.",
                ephemeral: true
            });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel("Verify with Discord")
                .setStyle(ButtonStyle.Link)
                .setURL(buildAuthUrl(interaction.user.id, interaction.guild.id))
        );

        return interaction.reply({
            content:
                `**${interaction.guild.name}** is asking you to verify.\n\n` +
                `If you continue, Professional Grass reads your Discord server list once and compares it ` +
                `to a list of known leak servers. It saves **only whether you matched** (and which ones). ` +
                `Your full server list and your login token are **not** kept.\n\n` +
                `Your result can be seen by staff of servers you're in that use Professional Grass. ` +
                `You can view or delete it any time with \`/mydata\`.` +
                (PRIVACY_URL ? `\nPrivacy policy: ${PRIVACY_URL}` : "") +
                `\n\nThe link expires in 10 minutes.`,
            components: [row],
            ephemeral: true
        });
    }

    if (!interaction.isChatInputCommand()) return;

    try {
        // ==================================================
        // /mydata (anyone, anywhere)
        // ==================================================

        if (interaction.commandName === "mydata") {
            const record = database.verifications[interaction.user.id];

            if (interaction.options.getSubcommand() === "delete") {
                delete database.verifications[interaction.user.id];
                saveDatabase();
                return interaction.reply({
                    content: "🌱 Your stored verification result has been deleted.",
                    ephemeral: true
                });
            }

            if (!record) {
                return interaction.reply({
                    content: "🌱 Nothing is stored about you.",
                    ephemeral: true
                });
            }

            const status = record.matches.length
                ? `🚩 Matched: ${record.matches.map(m => m.name).join(", ")}`
                : "✅ No matches";

            return interaction.reply({
                content:
                    `**Stored about you:** ${status}\n` +
                    `Checked <t:${Math.floor(record.checkedAt / 1000)}:R>\n\n` +
                    `Use \`/mydata delete\` to remove it. You can also revoke access under ` +
                    `User Settings → Authorized Apps.`,
                ephemeral: true
            });
        }

        if (!interaction.guild) {
            return interaction.reply({
                content: "🌱 Use this command inside a Discord server.",
                ephemeral: true
            });
        }

        // ==================================================
        // /setup
        // ==================================================

        if (interaction.commandName === "setup") {
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({
                    embeds: [errorEmbed("You need **Manage Server** to set up the app.")],
                    ephemeral: true
                });
            }

            const channel = interaction.options.getChannel("alert_channel");
            const staffRole = interaction.options.getRole("staff_role");
            const verifiedRole = interaction.options.getRole("verified_role");

            database.guilds[interaction.guildId] = {
                alertChannelId: channel.id,
                staffRoleId: staffRole?.id || null,
                verifiedRoleId: verifiedRole?.id || null,
                autoScan: true,
                configuredAt: new Date().toISOString()
            };
            saveDatabase();

            let warning = "";
            const me = interaction.guild.members.me;
            if (verifiedRole && (verifiedRole.managed || verifiedRole.position >= me.roles.highest.position)) {
                warning =
                    `\n\n⚠️ Move my role above ${verifiedRole} in Server Settings → Roles, ` +
                    `otherwise I can't hand it out.`;
            }

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "SETUP COMPLETE",
                        `Professional Grass is now protecting **${interaction.guild.name}**.\n\n` +
                        `🚨 **Alerts:** ${channel}\n` +
                        `🛡️ **Staff:** ${staffRole || "Members with Manage Server"}\n` +
                        `✅ **Verified role:** ${verifiedRole || "None"}\n` +
                        `🔎 **New-member checks:** Enabled\n\n` +
                        `Next: run \`/verifypanel\` in a channel so members can verify.` +
                        warning
                    )
                ]
            });
        }

        // ==================================================
        // STAFF PERMISSIONS
        // ==================================================

        const staffCommands = [
            "verifypanel",
            "settings",
            "autoscan",
            "check",
            "scan",
            "whitelist",
            "unwhitelist",
            "stats"
        ];

        if (staffCommands.includes(interaction.commandName) && !isStaff(interaction)) {
            return interaction.reply({
                embeds: [errorEmbed("You aren't allowed to use Professional Grass staff commands.")],
                ephemeral: true
            });
        }

        // ==================================================
        // /verifypanel
        // ==================================================

        if (interaction.commandName === "verifypanel") {
            if (!getGuildConfig(interaction.guildId)) {
                return interaction.reply({
                    content: "❌ Run `/setup` first.",
                    ephemeral: true
                });
            }

            const embed = baseEmbed()
                .setTitle("🔒 MEMBER VERIFICATION")
                .setDescription(
                    "Members are asked to verify their account.\n\n" +
                    "Press **Verify** and authorize with Discord. Professional Grass compares your server " +
                    "list to a list of known leak servers and saves only whether you matched. " +
                    "Your login token is never stored.\n\n" +
                    "View or delete your result anytime with `/mydata`."
                );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId("grass_verify")
                    .setLabel("Verify")
                    .setEmoji("🌱")
                    .setStyle(ButtonStyle.Success)
            );

            await interaction.channel.send({ embeds: [embed], components: [row] });

            return interaction.reply({
                content: "✅ Verification panel posted.",
                ephemeral: true
            });
        }

        // ==================================================
        // /settings
        // ==================================================

        if (interaction.commandName === "settings") {
            const config = getGuildConfig(interaction.guildId);

            if (!config) {
                return interaction.reply({
                    content: "❌ Professional Grass hasn't been configured. Run `/setup` first.",
                    ephemeral: true
                });
            }

            const whitelistCount = (database.whitelists[interaction.guildId] || []).length;

            return interaction.reply({
                embeds: [
                    baseEmbed()
                        .setTitle("⚙️ PROFESSIONAL GRASS SETTINGS")
                        .addFields(
                            {
                                name: "🚨 Alert Channel",
                                value: config.alertChannelId ? `<#${config.alertChannelId}>` : "Not configured",
                                inline: true
                            },
                            {
                                name: "🛡️ Staff Role",
                                value: config.staffRoleId ? `<@&${config.staffRoleId}>` : "Manage Server",
                                inline: true
                            },
                            {
                                name: "✅ Verified Role",
                                value: config.verifiedRoleId ? `<@&${config.verifiedRoleId}>` : "None",
                                inline: true
                            },
                            {
                                name: "🔎 Auto Scan",
                                value: config.autoScan ? "✅ Enabled" : "❌ Disabled",
                                inline: true
                            },
                            { name: "📋 Whitelisted", value: String(whitelistCount), inline: true },
                            { name: "🌐 App Servers", value: String(client.guilds.cache.size), inline: true }
                        )
                ],
                ephemeral: true
            });
        }

        // ==================================================
        // /autoscan
        // ==================================================

        if (interaction.commandName === "autoscan") {
            const config = getGuildConfig(interaction.guildId);

            if (!config) {
                return interaction.reply({ content: "❌ Run `/setup` first.", ephemeral: true });
            }

            const enabled = interaction.options.getBoolean("enabled", true);
            config.autoScan = enabled;
            saveDatabase();

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "AUTO SCAN",
                        enabled
                            ? "🔎 New members will now be checked automatically (if they've verified)."
                            : "⏸️ Automatic new-member checks have been disabled."
                    )
                ],
                ephemeral: true
            });
        }

        // ==================================================
        // /check
        // ==================================================

        if (interaction.commandName === "check") {
            await interaction.deferReply({ ephemeral: true });

            const user = interaction.options.getUser("user", true);

            if (isWhitelisted(interaction.guildId, user.id)) {
                return interaction.editReply({
                    embeds: [successEmbed("WHITELISTED", `${user} is whitelisted in this server.`)]
                });
            }

            const matches = await checkUserAgainstLeakServers(user.id);

            if (!matches.length) {
                return interaction.editReply({
                    embeds: [isVerified(user.id) ? clearEmbed(user) : unverifiedEmbed(user)]
                });
            }

            saveDetection(interaction.guildId, user.id, matches);
            await sendDetectionAlert(interaction.guild, user, matches);

            return interaction.editReply({ embeds: [matchEmbed(user, matches)] });
        }

        // ==================================================
        // /whitelist
        // ==================================================

        if (interaction.commandName === "whitelist") {
            const user = interaction.options.getUser("user", true);
            addToWhitelist(interaction.guildId, user.id);

            return interaction.reply({
                embeds: [
                    successEmbed(
                        "WHITELIST UPDATED",
                        `${user} will now be ignored by Professional Grass in **${interaction.guild.name}**.`
                    )
                ],
                ephemeral: true
            });
        }

        // ==================================================
        // /unwhitelist
        // ==================================================

        if (interaction.commandName === "unwhitelist") {
            const user = interaction.options.getUser("user", true);
            removeFromWhitelist(interaction.guildId, user.id);

            return interaction.reply({
                embeds: [successEmbed("WHITELIST UPDATED", `${user} is no longer whitelisted.`)],
                ephemeral: true
            });
        }

        // ==================================================
        // /stats
        // ==================================================

        if (interaction.commandName === "stats") {
            const detections = database.detections.filter(
                item => item.protectedGuildId === interaction.guildId
            );
            const uniqueUsers = new Set(detections.map(item => item.userId));

            return interaction.reply({
                embeds: [
                    baseEmbed()
                        .setTitle("📊 PROFESSIONAL GRASS STATS")
                        .addFields(
                            { name: "🚨 Detections", value: String(detections.length), inline: true },
                            { name: "🐀 Unique Users", value: String(uniqueUsers.size), inline: true },
                            {
                                name: "🔎 Known Servers",
                                value: String(Object.keys(database.leakServers).length),
                                inline: true
                            },
                            {
                                name: "✅ Verified Users",
                                value: String(Object.keys(database.verifications).length),
                                inline: true
                            },
                            { name: "🌐 Servers Using App", value: String(client.guilds.cache.size), inline: true }
                        )
                ],
                ephemeral: true
            });
        }

        // ==================================================
        // /scan
        // ==================================================

        if (interaction.commandName === "scan") {
            await interaction.deferReply({ ephemeral: true });

            let members;
            try {
                members = await interaction.guild.members.fetch();
            } catch (error) {
                console.error(error);
                return interaction.editReply({
                    embeds: [
                        errorEmbed(
                            "I couldn't retrieve the server member list. Make sure **Server Members Intent** is enabled."
                        )
                    ]
                });
            }

            const membersToCheck = members.filter(
                m => !m.user.bot && !isWhitelisted(interaction.guildId, m.id)
            );

            const flagged = [];
            let checked = 0;
            let unverified = 0;

            for (const member of membersToCheck.values()) {
                const matches = await checkUserAgainstLeakServers(member.id);
                checked++;

                if (matches.length) {
                    flagged.push({ user: member.user, matches });
                    saveDetection(interaction.guildId, member.id, matches);
                } else if (!isVerified(member.id)) {
                    unverified++;
                }
            }

            const summary =
                `🔎 Checked **${checked}** members.\n` +
                `⚪ **${unverified}** haven't verified yet, so they couldn't be checked.\n\n`;

            if (!flagged.length) {
                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            "SCAN COMPLETE",
                            summary + `✅ No known matches among verified members.\n\n🌱 The lawn is clean (so far).`
                        )
                    ]
                });
            }

            const displayed = flagged.slice(0, 20);
            const lines = displayed.map(result => {
                const serverNames = result.matches.map(m => m.name).join(", ");
                return `🐀 <@${result.user.id}>\n↳ ${serverNames}`;
            });

            let description = summary + `🚨 Found **${flagged.length}** match(es).\n\n` + lines.join("\n\n");

            if (flagged.length > 20) {
                description += `\n\n*...and ${flagged.length - 20} more.*`;
            }

            return interaction.editReply({
                embeds: [
                    baseEmbed()
                        .setColor(0xed4245)
                        .setTitle("🚨 THE GRASS HAS SPOKEN")
                        .setDescription(description.slice(0, 4000))
                ]
            });
        }

        // ==================================================
        // OWNER COMMANDS
        // ==================================================

        if (interaction.commandName === "leakserver") {
            if (!isBotOwner(interaction.user.id)) {
                return interaction.reply({
                    embeds: [errorEmbed("Only the Professional Grass bot owner can manage the central server list.")],
                    ephemeral: true
                });
            }

            const subcommand = interaction.options.getSubcommand();

            // ---------- ADD ----------
            if (subcommand === "add") {
                await interaction.deferReply({ ephemeral: true });

                const inviteInput = interaction.options.getString("invite");
                const idInput = interaction.options.getString("server_id");
                const customName = interaction.options.getString("name");

                let serverId = null;
                let discoveredName = null;

                if (inviteInput) {
                    // Resolve an invite to its server WITHOUT joining it.
                    const code = inviteInput
                        .trim()
                        .replace(/^https?:\/\//i, "")
                        .replace(/^(www\.)?(discord\.gg|discord(app)?\.com\/invite)\//i, "")
                        .split(/[/?#]/)[0];

                    try {
                        const invite = await client.fetchInvite(code);
                        serverId = invite.guild?.id || null;
                        discoveredName = invite.guild?.name || null;
                    } catch {
                        return interaction.editReply({
                            embeds: [errorEmbed("I couldn't resolve that invite. It may be expired, invalid, or revoked.")]
                        });
                    }

                    if (!serverId) {
                        return interaction.editReply({
                            embeds: [errorEmbed("That invite doesn't point to a server (it may be a group DM).")]
                        });
                    }
                } else if (idInput) {
                    serverId = idInput.trim();
                    if (!/^\d{15,25}$/.test(serverId)) {
                        return interaction.editReply({
                            embeds: [errorEmbed("That doesn't look like a valid server ID.")]
                        });
                    }
                    discoveredName = client.guilds.cache.get(serverId)?.name || null;
                } else {
                    return interaction.editReply({
                        embeds: [errorEmbed("Give either an `invite` link or a `server_id`.")]
                    });
                }

                const name = customName || discoveredName || `Unknown server (${serverId})`;

                database.leakServers[serverId] = {
                    name,
                    addedAt: new Date().toISOString()
                };
                saveDatabase();

                return interaction.editReply({
                    embeds: [
                        successEmbed(
                            "SERVER ADDED",
                            `🚨 **${name}** has been added to the central known-server list.\n` +
                            `ID: \`${serverId}\`\n\n` +
                            `The bot does **not** need to join it. Members are matched when they press Verify.\n` +
                            `Members who verified **before** this was added need to verify again to be checked against it.`
                        )
                    ]
                });
            }

            // ---------- REMOVE ----------
            if (subcommand === "remove") {
                const serverId = interaction.options.getString("server_id", true).trim();
                const existing = database.leakServers[serverId];

                if (!existing) {
                    return interaction.reply({
                        embeds: [errorEmbed("That server isn't in the central list.")],
                        ephemeral: true
                    });
                }

                const oldName = existing.name;
                delete database.leakServers[serverId];
                saveDatabase();

                return interaction.reply({
                    embeds: [successEmbed("SERVER REMOVED", `**${oldName}** has been removed from the central list.`)],
                    ephemeral: true
                });
            }

            // ---------- LIST ----------
            if (subcommand === "list") {
                const entries = Object.entries(database.leakServers);

                if (!entries.length) {
                    return interaction.reply({
                        content: "🌱 The central known-server list is empty.",
                        ephemeral: true
                    });
                }

                const text = entries
                    .map(([id, info], index) => `${index + 1}. **${info.name}**\n   \`${id}\``)
                    .join("\n\n");

                return interaction.reply({
                    embeds: [
                        baseEmbed().setTitle("🚨 CENTRAL SERVER LIST").setDescription(text.slice(0, 4000))
                    ],
                    ephemeral: true
                });
            }
        }
    } catch (error) {
        console.error("❌ Command error:", error);

        const response = {
            content: "❌ Professional Grass fell over in the long grass. Check the logs.",
            ephemeral: true
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(response).catch(() => {});
        } else {
            await interaction.reply(response).catch(() => {});
        }
    }
});

// ==========================================================
// ERRORS
// ==========================================================

client.on("error", error => {
    console.error("Discord client error:", error);
});

process.on("unhandledRejection", error => {
    console.error("Unhandled rejection:", error);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
        saveDatabase();
        process.exit(0);
    });
}

// ==========================================================
// START PROFESSIONAL GRASS
// ==========================================================

async function start() {
    try {
        await registerCommands();
        await client.login(TOKEN);
    } catch (error) {
        console.error("❌ PROFESSIONAL GRASS FAILED TO START");
        console.error(error);
        process.exit(1);
    }
}

start();
