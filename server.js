const express = require('express');
const path = require('path');
const { 
    Client, 
    GatewayIntentBits, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const fs = require('fs');
const dotenv = require('dotenv');
const app = express();
const PORT = 3000;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Load configuration
const config = require('./config.json');
const settings = require('./settings.json');
const disputes = require('./dispute.json');
// Load environment variables
dotenv.config();
// Initialize Discord Bot
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates
    ]
});

let botStatus = {
    isConnected: false,
    guildCount: 0,
    totalMembers: 0,
    onlineMembers: 0,
    mainGuild: null
};

// Verify System Logic
const activeVerifications = new Map();

// Temp Voice System Logic
const tempVoiceChannels = new Map();
const originalNicknames = new Map();

// Discord bot connection
client.once('ready', () => {
    console.log(`🤖 Discord bot logged in as ${client.user.tag}`);
    botStatus.isConnected = true;
    botStatus.guildCount = client.guilds.cache.size;
    
    // Calculate total members and online members
    let totalMembers = 0;
    let onlineMembers = 0;
    
    client.guilds.cache.forEach(guild => {
        totalMembers += guild.memberCount;
        onlineMembers += guild.members.cache.filter(member => 
            member.presence?.status === 'online' || 
            member.presence?.status === 'idle' || 
            member.presence?.status === 'dnd'
        ).size;
    });
    
    botStatus.totalMembers = totalMembers;
    botStatus.onlineMembers = onlineMembers;
    
    const mainGuild = client.guilds.cache.get(config.mainGuild);
    if (mainGuild) {
        botStatus.mainGuild = {
            name: mainGuild.name,
            id: mainGuild.id,
            memberCount: mainGuild.memberCount
        };
        console.log(`⭐ Main guild: ${mainGuild.name} (${mainGuild.memberCount} members)`);
    } else {
        console.log('❌ Main guild not found!');
    }
    
    console.log(`📊 Stats: ${botStatus.guildCount} servers, ${botStatus.totalMembers} total members, ${botStatus.onlineMembers} online members`);
    console.log(`⚖️ Dispute system: ${settings.systems.dispute ? 'ENABLED' : 'DISABLED'}`);
    console.log(`✅ Verify system: ${settings.systems.verify ? 'ENABLED' : 'DISABLED'}`);
    console.log(`🎤 Temp Voice system: ${settings.systems.tempVoice ? 'ENABLED' : 'DISABLED'}`);
    console.log(`📝 Active disputes: ${require('./dispute.json').activeDisputes.length}`);
});

// Dispute System Logic
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!settings.systems.dispute) return;
    
    const member = newState.member;
    const newChannel = newState.channel;
    
    // Only trigger when user joins a voice channel
    if (!newChannel || oldState.channelId === newState.channelId) return;
    
    // Check if user is in any active dispute
    const disputesData = require('./dispute.json');
    const userDisputes = disputesData.activeDisputes.filter(dispute => 
        dispute.user1 === member.id || dispute.user2 === member.id
    );
    
    if (userDisputes.length === 0) return;
    
    for (const dispute of userDisputes) {
        const otherUserId = dispute.user1 === member.id ? dispute.user2 : dispute.user1;
        const otherUser = await client.users.fetch(otherUserId).catch(() => null);
        
        if (!otherUser) continue;
        
        // Check if the other user is in the same voice channel
        const otherMember = newChannel.guild.members.cache.get(otherUserId);
        if (otherMember && otherMember.voice.channelId === newChannel.id) {
            // Disconnect the user who just joined
            try {
                await member.voice.disconnect('Dispute system: Cannot join same channel as disputed user');
                
                // Send DM to the user
                const embed = createDisputeEmbed(member, otherUser, newChannel.guild);
                await member.send({ embeds: [embed] }).catch(() => {
                    console.log(`Could not send DM to ${member.user.tag}`);
                });
                
                // Log to dispute channel if set
                if (settings.disputeSettings.logChannel) {
                    const logChannel = newChannel.guild.channels.cache.get(settings.disputeSettings.logChannel);
                    if (logChannel) {
                        const logEmbed = new EmbedBuilder()
                            .setTitle('Dispute Violation')
                            .setDescription(`**${member.user.tag}** tried to join **${newChannel.name}** while in dispute with **${otherUser.tag}**`)
                            .setColor(0xff0000)
                            .setTimestamp();
                        
                        await logChannel.send({ embeds: [logEmbed] });
                    }
                }
                
                console.log(`⚖️ Prevented ${member.user.tag} from joining ${newChannel.name} due to dispute with ${otherUser.tag}`);
            } catch (error) {
                console.error('Error handling dispute violation:', error);
            }
            break;
        }
    }
});

function createDisputeEmbed(member, disputedUser, guild) {
    const embedSettings = settings.disputeSettings.embed;
    
    let title = embedSettings.title || 'Dispute Alert';
    let description = embedSettings.description || 'You are in a dispute with another user.';
    let color = embedSettings.color || '#ff0000';
    let thumbnail = embedSettings.thumbnail || '';
    let footer = embedSettings.footer || 'Dispute System';
    
    // Replace placeholders
    description = description.replace(/<server>/g, guild.name);
    description = description.replace(/<disputed>/g, `<@${disputedUser.id}>`);
    
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setFooter({ text: footer })
        .setTimestamp();
    
    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }
    
    return embed;
}

// Verify System Voice State Handler
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!settings.systems.verify) return;
    
    const member = newState.member;
    const newChannel = newState.channel;
    const verifySettings = settings.verifySettings;

    // Check if user joined the verify channel
    if (newChannel && newChannel.id === verifySettings.verifyChannel && !activeVerifications.has(member.id)) {
        await handleVerificationRequest(member, newChannel);
    }
    
    // Clean up if user leaves verification channel
    if (oldState.channelId === verifySettings.verifyChannel && newChannel?.id !== verifySettings.verifyChannel) {
        if (activeVerifications.has(member.id)) {
            const verification = activeVerifications.get(member.id);
            if (verification.message) {
                try {
                    await verification.message.delete().catch(() => {});
                } catch (error) {
                    console.log('Could not delete verification message');
                }
            }
            activeVerifications.delete(member.id);
        }
    }

    // Check for empty verification rooms to delete
    await checkEmptyVerificationRooms(oldState, newState);
});

async function checkEmptyVerificationRooms(oldState, newState) {
    const verifySettings = settings.verifySettings;
    if (!verifySettings.category) return;

    const category = client.channels.cache.get(verifySettings.category);
    if (!category) return;

    // Get all voice channels in the verification category
    const verificationChannels = category.children.cache.filter(channel => 
        channel.type === 2 && channel.name.startsWith('verify-')
    );

    for (const [channelId, channel] of verificationChannels) {
        // Check if channel is empty
        if (channel.members.size === 0) {
            try {
                await channel.delete('Verification room empty');
                console.log(`✅ Deleted empty verification room: ${channel.name}`);
            } catch (error) {
                console.error('Error deleting empty verification room:', error);
            }
        }
    }
}

async function handleVerificationRequest(member, channel) {
    const verifySettings = settings.verifySettings;
    
    if (!verifySettings.logChannel) {
        console.log('❌ Verify log channel not set');
        return;
    }
    
    const logChannel = member.guild.channels.cache.get(verifySettings.logChannel);
    if (!logChannel) {
        console.log('❌ Verify log channel not found');
        return;
    }

    // Create embed
    const embed = createVerifyEmbed(member, channel, null);
    
    // Create buttons
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`verify_claim_${member.id}`)
                .setLabel('Claim Verification')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✅')
        );

    try {
        const message = await logChannel.send({
            embeds: [embed],
            components: [row]
        });

        activeVerifications.set(member.id, {
            message: message,
            channel: channel,
            claimedBy: null,
            createdAt: Date.now()
        });

        console.log(`✅ Verification request created for ${member.user.tag}`);
    } catch (error) {
        console.error('Error creating verification request:', error);
    }
}

function createVerifyEmbed(member, channel, claimedBy = null) {
    const embedSettings = settings.verifySettings.embed;
    
    let title = embedSettings.title || 'Verification Request';
    let description = embedSettings.description || 'User is requesting verification.';
    let color = embedSettings.color || '#00ff00';
    let thumbnail = embedSettings.thumbnail || member.user.displayAvatarURL();
    let footer = embedSettings.footer || 'Verification System';

    // Replace placeholders
    description = description.replace(/<user>/g, `<@${member.id}>`);
    description = description.replace(/<channel>/g, `**${channel.name}**`);
    description = description.replace(/<admin>/g, claimedBy ? `<@${claimedBy}>` : '*Waiting for admin...*');

    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor(color)
        .setThumbnail(thumbnail)
        .setFooter({ text: footer })
        .setTimestamp()
        .addFields(
            { name: 'User', value: `<@${member.id}>`, inline: true },
            { name: 'Tag', value: member.user.tag, inline: true },
            { name: 'Joined', value: `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>`, inline: true }
        );

    if (claimedBy) {
        embed.addFields({ name: 'Claimed By', value: `<@${claimedBy}>`, inline: true });
    }

    return embed;
}

// Temp Voice System Voice State Handler
client.on('voiceStateUpdate', async (oldState, newState) => {
    if (!settings.systems.tempVoice) return;
    
    const tempVoiceSettings = settings.tempVoiceSettings;
    const member = newState.member;
    const newChannel = newState.channel;
    const oldChannel = oldState.channel;

    // User joined the temp voice channel
    if (newChannel && newChannel.id === tempVoiceSettings.voiceChannel) {
        await handleTempVoiceJoin(member, newChannel);
    }

    // User left a temp voice channel
    if (oldChannel && tempVoiceChannels.has(oldChannel.id)) {
        await handleTempVoiceLeave(member, oldChannel);
    }

    // User joined a temp voice channel (not the creator)
    if (newChannel && tempVoiceChannels.has(newChannel.id) && newChannel.id !== tempVoiceSettings.voiceChannel) {
        await handleTempVoiceUserJoin(member, newChannel);
    }

    // User left a temp voice channel
    if (oldChannel && tempVoiceChannels.has(oldChannel.id) && oldChannel.id !== tempVoiceSettings.voiceChannel) {
        await handleTempVoiceUserLeave(member, oldChannel);
    }

    // Check for empty temp voice channels to delete
    await checkEmptyTempVoiceChannels();
});

async function handleTempVoiceJoin(member, channel) {
    const tempVoiceSettings = settings.tempVoiceSettings;
    
    if (!tempVoiceSettings.category) {
        console.log('❌ Temp voice category not set');
        return;
    }

    const category = channel.guild.channels.cache.get(tempVoiceSettings.category);
    if (!category) {
        console.log('❌ Temp voice category not found');
        return;
    }

    try {
        // Generate channel name
        const emojis = tempVoiceSettings.emojis || ['🎮', '🎵', '🎤'];
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        let channelName = tempVoiceSettings.channelName.replace('{OWNER_NICKNAME}', member.displayName);
        channelName = `${randomEmoji} ${channelName}`;

        // Create temp voice channel
        const tempChannel = await channel.guild.channels.create({
            name: channelName,
            type: ChannelType.GuildVoice,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: channel.guild.id,
                    allow: ['ViewChannel', 'Connect']
                },
                {
                    id: member.id,
                    allow: ['ManageChannels', 'MoveMembers', 'MuteMembers', 'DeafenMembers']
                },
                {
                    id: client.user.id,
                    allow: ['ViewChannel', 'Connect', 'ManageChannels']
                }
            ]
        });

        // Store channel info
        tempVoiceChannels.set(tempChannel.id, {
            ownerId: member.id,
            ownerName: member.displayName,
            createdAt: Date.now(),
            isLocked: false,
            trustedUsers: [],
            blockedUsers: [],
            userLimit: 0,
            channelEmoji: randomEmoji
        });

        // STEP 1: Change user nickname with emoji BEFORE moving
        const originalNickname = member.nickname || member.user.username;
        originalNicknames.set(member.id, originalNickname);
        
        const newNickname = `${randomEmoji} ${originalNickname}`;
        try {
            await member.setNickname(newNickname);
            console.log(`🎤 Updated ${member.user.tag} nickname to ${newNickname}`);
        } catch (error) {
            console.log(`❌ Could not update nickname for ${member.user.tag}:`, error.message);
        }

        // STEP 2: Move user to new channel AFTER nickname change
        await member.voice.setChannel(tempChannel);

        // Send logs and control panel
        await sendTempVoiceLogs('CHANNEL_CREATED', member, tempChannel);
        await sendControlPanel(member, tempChannel);

        console.log(`🎤 Created temp voice channel for ${member.user.tag}: ${tempChannel.name}`);

    } catch (error) {
        console.error('Error creating temp voice channel:', error);
    }
}

async function handleTempVoiceUserJoin(member, channel) {
    const channelInfo = tempVoiceChannels.get(channel.id);
    
    if (!channelInfo) return;

    // Change user nickname with channel emoji
    const originalNickname = member.nickname || member.user.username;
    
    // Only save original nickname if not already saved
    if (!originalNicknames.has(member.id)) {
        originalNicknames.set(member.id, originalNickname);
    }
    
    const newNickname = `${channelInfo.channelEmoji} ${originalNicknames.get(member.id)}`;
    try {
        await member.setNickname(newNickname);
        console.log(`🎤 Updated ${member.user.tag} nickname to ${newNickname}`);
    } catch (error) {
        console.log(`❌ Could not update nickname for ${member.user.tag}:`, error.message);
    }

    await sendTempVoiceLogs('USER_JOINED', member, channel);
    console.log(`🎤 ${member.user.tag} joined temp voice channel: ${channel.name}`);
}

async function handleTempVoiceUserLeave(member, channel) {
    const channelInfo = tempVoiceChannels.get(channel.id);
    
    if (!channelInfo) return;

    // Restore original nickname
    if (originalNicknames.has(member.id)) {
        const originalNickname = originalNicknames.get(member.id);
        await member.setNickname(originalNickname).catch(() => {});
        originalNicknames.delete(member.id);
    }

    // Send user leave log
    await sendTempVoiceLogs('USER_LEFT', member, channel);

    console.log(`🎤 ${member.user.tag} left temp voice channel: ${channel.name}`);
}

async function handleTempVoiceLeave(member, channel) {
    const channelInfo = tempVoiceChannels.get(channel.id);
    
    if (!channelInfo) return;

    // Restore original nickname
    if (originalNicknames.has(member.id)) {
        const originalNickname = originalNicknames.get(member.id);
        await member.setNickname(originalNickname).catch(() => {});
        originalNicknames.delete(member.id);
    }

    // If owner leaves, transfer ownership or prepare for deletion
    if (member.id === channelInfo.ownerId) {
        const remainingMembers = channel.members.filter(m => m.id !== member.id);
        
        if (remainingMembers.size > 0) {
            // Transfer ownership to first member
            const newOwner = remainingMembers.first();
            channelInfo.ownerId = newOwner.id;
            channelInfo.ownerName = newOwner.displayName;
            
            // Update permissions
            await channel.permissionOverwrites.edit(member.id, { ManageChannels: null });
            await channel.permissionOverwrites.edit(newOwner.id, { ManageChannels: true });
            
            // Send ownership transfer log
            await sendTempVoiceLogs('OWNER_CHANGED', newOwner, channel, member);
            
            console.log(`🎤 Transferred ownership of ${channel.name} to ${newOwner.user.tag}`);
        }
    }
}

async function checkEmptyTempVoiceChannels() {
    const tempVoiceSettings = settings.tempVoiceSettings;
    if (!tempVoiceSettings.category) return;

    const category = client.channels.cache.get(tempVoiceSettings.category);
    if (!category) return;

    // Get all voice channels in the temp voice category
    const tempChannels = category.children.cache.filter(channel => 
        channel.type === ChannelType.GuildVoice && tempVoiceChannels.has(channel.id)
    );

    for (const [channelId, channel] of tempChannels) {
        // Check if voice channel is empty
        if (channel.members.size === 0) {
            try {
                // Delete control panel message if exists
                const channelInfo = tempVoiceChannels.get(channelId);
                if (channelInfo && channelInfo.controlPanelMessage && channelInfo.textChannelId) {
                    try {
                        const textChannel = client.channels.cache.get(channelInfo.textChannelId);
                        if (textChannel) {
                            const message = await textChannel.messages.fetch(channelInfo.controlPanelMessage).catch(() => null);
                            if (message) {
                                await message.delete();
                                console.log(`🗑️ Deleted control panel message for ${channel.name}`);
                            }
                        }
                    } catch (error) {
                        console.log('Could not delete control panel message');
                    }
                }

                // Send channel deleted log
                await sendTempVoiceLogs('CHANNEL_DELETED', null, channel);

                await channel.delete('Temp voice channel empty');
                tempVoiceChannels.delete(channelId);
                console.log(`🎤 Deleted empty temp voice channel: ${channel.name}`);
            } catch (error) {
                console.error('Error deleting empty temp voice channel:', error);
            }
        }
    }
}

// Temp Voice Logging System
async function sendTempVoiceLogs(action, member, channel, oldOwner = null) {
    const tempVoiceSettings = settings.tempVoiceSettings;
    
    if (!tempVoiceSettings.logChannel) {
        return;
    }

    const logChannel = client.channels.cache.get(tempVoiceSettings.logChannel);
    if (!logChannel) {
        return;
    }

    try {
        let embed;
        const channelInfo = tempVoiceChannels.get(channel.id);

        switch (action) {
            case 'CHANNEL_CREATED':
                embed = new EmbedBuilder()
                    .setTitle('🎤 Voice Channel Created')
                    .setDescription(`**Channel:** ${channel}\n**Owner:** <@${member.id}>\n**Name:** ${channel.name}`)
                    .setColor(0x00ff00)
                    .setTimestamp();
                break;

            case 'USER_JOINED':
                embed = new EmbedBuilder()
                    .setTitle('👤 User Joined Voice Channel')
                    .setDescription(`**User:** <@${member.id}>\n**Channel:** ${channel}\n**Members:** ${channel.members.size}`)
                    .setColor(0x00ae86)
                    .setTimestamp();
                break;

            case 'USER_LEFT':
                embed = new EmbedBuilder()
                    .setTitle('👤 User Left Voice Channel')
                    .setDescription(`**User:** <@${member.id}>\n**Channel:** ${channel}\n**Members:** ${channel.members.size}`)
                    .setColor(0xffa500)
                    .setTimestamp();
                break;

            case 'CHANNEL_DELETED':
                embed = new EmbedBuilder()
                    .setTitle('🗑️ Voice Channel Deleted')
                    .setDescription(`**Channel:** ${channel.name}\n**Reason:** Channel empty`)
                    .setColor(0xff0000)
                    .setTimestamp();
                break;

            case 'OWNER_CHANGED':
                embed = new EmbedBuilder()
                    .setTitle('👑 Voice Channel Owner Changed')
                    .setDescription(`**Channel:** ${channel}\n**New Owner:** <@${member.id}>\n**Previous Owner:** <@${oldOwner.id}>`)
                    .setColor(0x9b59b6)
                    .setTimestamp();
                break;
        }

        if (embed) {
            await logChannel.send({ embeds: [embed] });
        }
    } catch (error) {
        console.error('Error sending temp voice logs:', error);
    }
}

// Control Panel System
async function sendControlPanel(owner, voiceChannel) {
    try {
        const embed = new EmbedBuilder()
            .setTitle('🎤 Voice Channel Control Panel')
            .addFields(
                { name: ' Lock/Unlock', value: 'Toggle whether users can join', inline: true },
                { name: ' Add User', value: 'Grant access to specific users', inline: true },
                { name: ' Block User', value: 'Permanently deny access', inline: true },
                { name: ' Disconnect User', value: 'Remove user from channel', inline: true },
                { name: ' Set Limit', value: 'Maximum users allowed', inline: true },
                { name: ' Rename', value: 'Change channel name', inline: true }
            )
            .setColor(0x00AE86)


        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`tempvoice_lock_${voiceChannel.id}`)
                    .setLabel('Lock')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`tempvoice_trust_${voiceChannel.id}`)
                    .setLabel('Add User')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`tempvoice_block_${voiceChannel.id}`)
                    .setLabel('Block User')
                    .setStyle(ButtonStyle.Secondary)
            );

        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`tempvoice_disconnect_${voiceChannel.id}`)
                    .setLabel('Disconnect User')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`tempvoice_limit_${voiceChannel.id}`)
                    .setLabel('Set Limit')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`tempvoice_rename_${voiceChannel.id}`)
                    .setLabel('Rename')
                    .setStyle(ButtonStyle.Secondary)
            );

        // Send control panel to the voice channel itself
        const message = await voiceChannel.send({
            content: `<@${owner.id}> `,
            embeds: [embed],
            components: [row, row2]
        });

        // Store control panel message ID
        const channelInfo = tempVoiceChannels.get(voiceChannel.id);
        if (channelInfo) {
            channelInfo.controlPanelMessage = message.id;
            channelInfo.textChannelId = voiceChannel.id;
            tempVoiceChannels.set(voiceChannel.id, channelInfo);
        }

        console.log(`🎤 Sent control panel for ${voiceChannel.name} to the voice channel itself`);

    } catch (error) {
        console.error('Error sending control panel:', error);
    }
}

// Handle button interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [system, action, channelId] = interaction.customId.split('_');
    
    if (system === 'verify') {
        await handleVerifyInteraction(interaction, action, channelId);
    } else if (system === 'tempvoice') {
        await handleTempVoiceInteraction(interaction, action, channelId);
    }
});

// Verify System Interaction Handler
async function handleVerifyInteraction(interaction, subAction, userId) {
    console.log(`🔧 Button interaction: ${subAction} for user ${userId}`);
    
    if (!settings.systems.verify) {
        await interaction.reply({ 
            content: '❌ Verify system is disabled.', 
            flags: 64 // Ephemeral
        });
        return;
    }

    const member = interaction.guild.members.cache.get(userId);
    if (!member) {
        console.log(`❌ User ${userId} not found in guild`);
        await interaction.reply({ 
            content: '❌ User not found.', 
            flags: 64
        });
        return;
    }

    const verification = activeVerifications.get(userId);
    if (!verification) {
        console.log(`❌ No active verification found for user ${userId}`);
        console.log(`📋 Current active verifications:`, Array.from(activeVerifications.keys()));
        await interaction.reply({ 
            content: '❌ Verification request not found or expired.', 
            flags: 64
        });
        return;
    }

    console.log(`✅ Found verification for user ${userId}, claimed by: ${verification.claimedBy}`);

    const verifySettings = settings.verifySettings;

    // Check if user has admin role
    const hasAdminRole = interaction.member.roles.cache.some(role => 
        verifySettings.adminRoles.includes(role.id)
    );

    if (!hasAdminRole) {
        await interaction.reply({ 
            content: '❌ You do not have permission to manage verifications.', 
            flags: 64
        });
        return;
    }

    if (subAction === 'claim') {
        await handleClaimVerification(interaction, member, verification);
    } else if (subAction === 'boy' || subAction === 'girl') {
        await handleRoleAssignment(interaction, member, verification, subAction);
    }
}

// Temp Voice System Interaction Handler
async function handleTempVoiceInteraction(interaction, action, channelId) {
    if (!settings.systems.tempVoice) {
        await interaction.reply({ 
            content: '❌ Temp Voice system is disabled.', 
            flags: 64
        });
        return;
    }

    const voiceChannel = interaction.guild.channels.cache.get(channelId);
    if (!voiceChannel) {
        await interaction.reply({ 
            content: '❌ Voice channel not found.', 
            flags: 64
        });
        return;
    }

    const channelInfo = tempVoiceChannels.get(channelId);
    if (!channelInfo) {
        await interaction.reply({ 
            content: '❌ This is not a temp voice channel.', 
            flags: 64
        });
        return;
    }

    // Check if user is the owner
    if (interaction.user.id !== channelInfo.ownerId) {
        await interaction.reply({ 
            content: '❌ Only the channel owner can use these controls.', 
            flags: 64
        });
        return;
    }

    switch (action) {
        case 'lock':
            await handleLockChannel(interaction, voiceChannel, channelInfo);
            break;
        case 'trust':
            await handleTrustUser(interaction, voiceChannel, channelInfo);
            break;
        case 'block':
            await handleBlockUser(interaction, voiceChannel, channelInfo);
            break;
        case 'disconnect':
            await handleDisconnectUser(interaction, voiceChannel, channelInfo);
            break;
        case 'limit':
            await handleSetLimit(interaction, voiceChannel, channelInfo);
            break;
        case 'rename':
            await handleRenameChannel(interaction, voiceChannel, channelInfo);
            break;
    }
}

async function handleLockChannel(interaction, voiceChannel, channelInfo) {
    channelInfo.isLocked = !channelInfo.isLocked;
    tempVoiceChannels.set(voiceChannel.id, channelInfo);

    if (channelInfo.isLocked) {
        await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: false });
        // Allow trusted users to connect even when locked
        for (const trustedUserId of channelInfo.trustedUsers) {
            await voiceChannel.permissionOverwrites.edit(trustedUserId, { Connect: true });
        }
        await interaction.reply({ 
            content: '🔒 Channel locked! Only trusted users can join.', 
            flags: 64
        });
    } else {
        await voiceChannel.permissionOverwrites.edit(interaction.guild.id, { Connect: true });
        await interaction.reply({ 
            content: '🔓 Channel unlocked! Everyone can join.', 
            flags: 64
        });
    }
}

async function handleTrustUser(interaction, voiceChannel, channelInfo) {
    const modal = new ModalBuilder()
        .setCustomId(`tempvoice_trustmodal_${voiceChannel.id}`)
        .setTitle('Add Trusted User');

    const userIdInput = new TextInputBuilder()
        .setCustomId('user_id')
        .setLabel("User ID to trust")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter the user ID...");

    const actionRow = new ActionRowBuilder().addComponents(userIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

async function handleBlockUser(interaction, voiceChannel, channelInfo) {
    const modal = new ModalBuilder()
        .setCustomId(`tempvoice_blockmodal_${voiceChannel.id}`)
        .setTitle('Block User');

    const userIdInput = new TextInputBuilder()
        .setCustomId('user_id')
        .setLabel("User ID to block")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter the user ID...");

    const actionRow = new ActionRowBuilder().addComponents(userIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

async function handleDisconnectUser(interaction, voiceChannel, channelInfo) {
    const members = voiceChannel.members.filter(m => m.id !== interaction.user.id);
    
    if (members.size === 0) {
        await interaction.reply({ 
            content: '❌ No other users in the channel to disconnect.', 
            flags: 64
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`tempvoice_disconnectmodal_${voiceChannel.id}`)
        .setTitle('Disconnect User');

    const userIdInput = new TextInputBuilder()
        .setCustomId('user_id')
        .setLabel("User ID to disconnect")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter the user ID...");

    const actionRow = new ActionRowBuilder().addComponents(userIdInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

async function handleSetLimit(interaction, voiceChannel, channelInfo) {
    const modal = new ModalBuilder()
        .setCustomId(`tempvoice_limitmodal_${voiceChannel.id}`)
        .setTitle('Set User Limit');

    const limitInput = new TextInputBuilder()
        .setCustomId('user_limit')
        .setLabel("User limit (0-99, 0 for no limit)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter a number between 0-99...");

    const actionRow = new ActionRowBuilder().addComponents(limitInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

async function handleRenameChannel(interaction, voiceChannel, channelInfo) {
    const modal = new ModalBuilder()
        .setCustomId(`tempvoice_renamemodal_${voiceChannel.id}`)
        .setTitle('Rename Channel');

    const nameInput = new TextInputBuilder()
        .setCustomId('channel_name')
        .setLabel("New channel name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setPlaceholder("Enter new channel name...")
        .setMaxLength(100);

    const actionRow = new ActionRowBuilder().addComponents(nameInput);
    modal.addComponents(actionRow);

    await interaction.showModal(modal);
}

// Handle modal submissions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;

    const [system, action, channelId] = interaction.customId.split('_');
    
    if (system === 'tempvoice') {
        await handleTempVoiceModal(interaction, action, channelId);
    }
});

async function handleTempVoiceModal(interaction, action, channelId) {
    const voiceChannel = interaction.guild.channels.cache.get(channelId);
    if (!voiceChannel) return;

    const channelInfo = tempVoiceChannels.get(channelId);
    if (!channelInfo) return;

    // Check if user is the owner
    if (interaction.user.id !== channelInfo.ownerId) {
        await interaction.reply({ 
            content: '❌ Only the channel owner can use these controls.', 
            flags: 64
        });
        return;
    }

    switch (action) {
        case 'trustmodal':
            await handleTrustModal(interaction, voiceChannel, channelInfo);
            break;
        case 'blockmodal':
            await handleBlockModal(interaction, voiceChannel, channelInfo);
            break;
        case 'disconnectmodal':
            await handleDisconnectModal(interaction, voiceChannel, channelInfo);
            break;
        case 'limitmodal':
            await handleLimitModal(interaction, voiceChannel, channelInfo);
            break;
        case 'renamemodal':
            await handleRenameModal(interaction, voiceChannel, channelInfo);
            break;
    }
}

async function handleTrustModal(interaction, voiceChannel, channelInfo) {
    const userId = interaction.fields.getTextInputValue('user_id');
    
    try {
        const user = await interaction.guild.members.fetch(userId);
        if (!channelInfo.trustedUsers.includes(user.id)) {
            channelInfo.trustedUsers.push(user.id);
            tempVoiceChannels.set(voiceChannel.id, channelInfo);

            await voiceChannel.permissionOverwrites.edit(user.id, { Connect: true });
            await interaction.reply({ 
                content: `✅ Added <@${user.id}> to trusted users.`, 
                flags: 64
            });
        } else {
            await interaction.reply({ 
                content: `❌ <@${user.id}> is already trusted.`, 
                flags: 64
            });
        }
    } catch (error) {
        await interaction.reply({ 
            content: '❌ User not found. Please check the user ID.', 
            flags: 64
        });
    }
}

async function handleBlockModal(interaction, voiceChannel, channelInfo) {
    const userId = interaction.fields.getTextInputValue('user_id');
    
    try {
        const user = await interaction.guild.members.fetch(userId);
        if (!channelInfo.blockedUsers.includes(user.id)) {
            channelInfo.blockedUsers.push(user.id);
            tempVoiceChannels.set(voiceChannel.id, channelInfo);

            await voiceChannel.permissionOverwrites.edit(user.id, { Connect: false });
            
            // Disconnect if user is in the channel
            const member = voiceChannel.members.get(user.id);
            if (member) {
                await member.voice.disconnect('Blocked from channel');
            }

            await interaction.reply({ 
                content: `✅ Blocked <@${user.id}> from the channel.`, 
                flags: 64
            });
        } else {
            await interaction.reply({ 
                content: `❌ <@${user.id}> is already blocked.`, 
                flags: 64
            });
        }
    } catch (error) {
        await interaction.reply({ 
            content: '❌ User not found. Please check the user ID.', 
            flags: 64
        });
    }
}

async function handleDisconnectModal(interaction, voiceChannel, channelInfo) {
    const userId = interaction.fields.getTextInputValue('user_id');
    
    try {
        const user = await interaction.guild.members.fetch(userId);
        const member = voiceChannel.members.get(user.id);
        
        if (member) {
            await member.voice.disconnect('Disconnected by owner');
            await interaction.reply({ 
                content: `✅ Disconnected <@${user.id}> from the channel.`, 
                flags: 64
            });
        } else {
            await interaction.reply({ 
                content: `❌ <@${user.id}> is not in the channel.`, 
                flags: 64
            });
        }
    } catch (error) {
        await interaction.reply({ 
            content: '❌ User not found. Please check the user ID.', 
            flags: 64
        });
    }
}

async function handleLimitModal(interaction, voiceChannel, channelInfo) {
    const limitInput = interaction.fields.getTextInputValue('user_limit');
    const limit = parseInt(limitInput);
    
    if (isNaN(limit) || limit < 0 || limit > 99) {
        await interaction.reply({ 
            content: '❌ Please enter a valid number between 0-99.', 
            flags: 64
        });
        return;
    }

    channelInfo.userLimit = limit;
    tempVoiceChannels.set(voiceChannel.id, channelInfo);

    await voiceChannel.setUserLimit(limit);
    await interaction.reply({ 
        content: `✅ User limit set to ${limit === 0 ? 'unlimited' : limit}.`, 
        flags: 64
    });
}

async function handleRenameModal(interaction, voiceChannel, channelInfo) {
    const newName = interaction.fields.getTextInputValue('channel_name');
    
    // Keep the same emoji (don't generate a new one)
    const currentEmoji = channelInfo.channelEmoji;
    const finalName = `${currentEmoji} ${newName}`;

    await voiceChannel.setName(finalName);

    await interaction.reply({ 
        content: `✅ Channel renamed to: ${finalName}`, 
        flags: 64
    });
}

// Claim Verification Handler
async function handleClaimVerification(interaction, member, verification) {
    if (verification.claimedBy) {
        await interaction.reply({ 
            content: `❌ This verification is already claimed by <@${verification.claimedBy}>`, 
            flags: 64
        });
        return;
    }

    // Check if admin is in a voice channel
    if (!interaction.member.voice.channel) {
        await interaction.reply({ 
            content: '❌ You need to be in a voice channel to claim a verification.', 
            flags: 64
        });
        return;
    }

    verification.claimedBy = interaction.user.id;

    // Create private verification channel
    const verifySettings = settings.verifySettings;
    const category = interaction.guild.channels.cache.get(verifySettings.category);
    
    if (!category) {
        await interaction.reply({ 
            content: '❌ Verification category not found.', 
            flags: 64
        });
        return;
    }

    try {
        // Create verification room
        const verifyRoom = await interaction.guild.channels.create({
            name: `verify-${member.user.username}`,
            type: 2, // GUILD_VOICE
            parent: category.id,
            permissionOverwrites: [
                {
                    id: interaction.guild.id,
                    deny: ['ViewChannel', 'Connect']
                },
                {
                    id: member.id,
                    allow: ['ViewChannel', 'Connect', 'Speak']
                },
                {
                    id: interaction.user.id,
                    allow: ['ViewChannel', 'Connect', 'Speak', 'MoveMembers']
                },
                {
                    id: client.user.id,
                    allow: ['ViewChannel', 'Connect', 'Speak', 'MoveMembers']
                }
            ]
        });

        // Move both users to the verification room
        await member.voice.setChannel(verifyRoom).catch(() => {});
        await interaction.member.voice.setChannel(verifyRoom).catch(() => {});

        // Create new message with claimed info and role buttons
        const logChannel = interaction.guild.channels.cache.get(verifySettings.logChannel);
        if (logChannel) {
            const claimedEmbed = createVerifyEmbed(member, verification.channel, interaction.user.id)
                .setColor('#FFA500') // Orange color for claimed verification
                .addFields({ 
                    name: 'Status', 
                    value: '🟡 **Claimed - In Progress**', 
                    inline: true 
                });
            
            // Create role assignment buttons
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`verify_boy_${member.id}`)
                        .setLabel('Give Boy Role')
                        .setStyle(ButtonStyle.Success)
                        .setEmoji('👦'),
                    new ButtonBuilder()
                        .setCustomId(`verify_girl_${member.id}`)
                        .setLabel('Give Girl Role')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('👧')
                );

            try {
                const newMessage = await logChannel.send({
                    embeds: [claimedEmbed],
                    components: [row]
                });

                // Delete the original verification message
                try {
                    await verification.message.delete();
                    console.log(`✅ Deleted original verification message for ${member.user.tag}`);
                } catch (error) {
                    console.log('Could not delete original verification message');
                }

                // IMPORTANT: Update the verification object with the new message
                verification.message = newMessage;
                activeVerifications.set(member.id, verification); // Update the map

                console.log(`✅ Created new claimed verification message for ${member.user.tag}`);

            } catch (error) {
                console.error('Error sending claimed verification message:', error);
            }
        }

        await interaction.reply({ 
            content: `✅ Successfully claimed verification for ${member.user.tag}. Created room: ${verifyRoom}`, 
            flags: 64
        });

        console.log(`✅ Verification claimed by ${interaction.user.tag} for ${member.user.tag}`);

    } catch (error) {
        console.error('Error creating verification room:', error);
        await interaction.reply({ 
            content: '❌ Error creating verification room.', 
            flags: 64
        });
    }
}

// Role Assignment Handler
async function handleRoleAssignment(interaction, member, verification, roleType) {
    const verifySettings = settings.verifySettings;
    
    // Check if this admin claimed the verification
    if (verification.claimedBy !== interaction.user.id) {
        await interaction.reply({ 
            content: '❌ You can only assign roles to verifications you claimed.', 
            flags: 64
        });
        return;
    }

    const roleId = roleType === 'boy' ? verifySettings.boyRole : verifySettings.girlRole;
    const role = interaction.guild.roles.cache.get(roleId);

    if (!role) {
        await interaction.reply({ 
            content: `❌ ${roleType.charAt(0).toUpperCase() + roleType.slice(1)} role not found.`, 
            flags: 64
        });
        return;
    }

    try {
        // Remove both boy and girl roles if they exist
        if (verifySettings.boyRole) {
            await member.roles.remove(verifySettings.boyRole).catch(() => {});
        }
        if (verifySettings.girlRole) {
            await member.roles.remove(verifySettings.girlRole).catch(() => {});
        }

        // Add the selected role
        await member.roles.add(roleId);

        // Delete verification room if it exists
        const voiceChannel = interaction.member.voice.channel;
        if (voiceChannel && voiceChannel.parentId === verifySettings.category) {
            await voiceChannel.delete('Verification completed').catch(() => {});
        }

        // Update embed to show completion with error handling
        const completedEmbed = createVerifyEmbed(member, verification.channel, interaction.user.id)
            .setColor('#00ff00')
            .addFields({ 
                name: 'Status', 
                value: `✅ **Verified - ${roleType.charAt(0).toUpperCase() + roleType.slice(1)} Role Given**`, 
                inline: true 
            });

        try {
            await verification.message.edit({
                embeds: [completedEmbed],
                components: [] // Remove buttons after completion
            });
        } catch (error) {
            console.log('Could not update verification message for completion');
        }

        // Remove from active verifications
        activeVerifications.delete(member.id);

        await interaction.reply({ 
            content: `✅ Successfully gave ${roleType} role to ${member.user.tag}`, 
            flags: 64
        });

        console.log(`✅ ${member.user.tag} verified with ${roleType} role by ${interaction.user.tag}`);

    } catch (error) {
        console.error('Error assigning role:', error);
        await interaction.reply({ 
            content: '❌ Error assigning role.', 
            flags: 64
        });
    }
}

client.on('disconnect', () => {
    botStatus.isConnected = false;
    console.log('❌ Discord bot disconnected');
});
client.login(process.env.TOKEN).catch(error => { // Changed from 'token'
    console.error('❌ Failed to login to Discord:', error);
    botStatus.isConnected = false;
});
// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

app.get('/distube', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'distube.html'));
});

app.get('/verify', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'verify.html'));
});

app.get('/voice', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'voice.html'));
});

app.get('/help', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'help.html'));
});

// API endpoint to get settings
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

// API endpoint to get disputes
app.get('/api/disputes', (req, res) => {
    const disputesData = require('./dispute.json');
    res.json(disputesData);
});

// API endpoint to get bot stats
app.get('/api/stats', (req, res) => {
    // Count enabled systems
    const enabledSystems = Object.values(settings.systems).filter(status => status).length;
    const totalSystems = Object.keys(settings.systems).length;
    
    const disputesData = require('./dispute.json');
    
    res.json({
        bot: botStatus,
        systems: {
            enabled: enabledSystems,
            total: totalSystems,
            enabledList: Object.entries(settings.systems)
                .filter(([_, status]) => status)
                .map(([system]) => system)
        },
        settings: settings,
        disputes: {
            active: disputesData.activeDisputes.length
        },
        tempVoice: {
            active: tempVoiceChannels.size
        }
    });
});

// API endpoint to update settings
app.post('/api/settings', (req, res) => {
    try {
        const { system, enabled } = req.body;
        
        if (settings.systems.hasOwnProperty(system)) {
            settings.systems[system] = enabled;
            
            // Save to file
            fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
            
            console.log(`⚙️ System ${system} ${enabled ? 'enabled' : 'disabled'}`);
            res.json({ success: true, message: `System ${system} ${enabled ? 'enabled' : 'disabled'}` });
        } else {
            res.status(400).json({ success: false, message: 'Invalid system' });
        }
    } catch (error) {
        console.error('Error updating settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to update dispute settings
app.post('/api/dispute/settings', (req, res) => {
    try {
        const { logChannel, embed } = req.body;
        
        if (logChannel !== undefined) {
            settings.disputeSettings.logChannel = logChannel;
        }
        
        if (embed) {
            settings.disputeSettings.embed = { ...settings.disputeSettings.embed, ...embed };
        }
        
        // Save to file
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
        
        console.log('⚖️ Dispute settings updated');
        res.json({ success: true, message: 'Dispute settings updated' });
    } catch (error) {
        console.error('Error updating dispute settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to create dispute
app.post('/api/dispute/create', (req, res) => {
    try {
        const { user1, user2 } = req.body;
        
        if (!user1 || !user2) {
            return res.status(400).json({ success: false, message: 'Both user IDs are required' });
        }
        
        const disputesData = require('./dispute.json');
        
        // Check if dispute already exists
        const existingDispute = disputesData.activeDisputes.find(dispute => 
            (dispute.user1 === user1 && dispute.user2 === user2) ||
            (dispute.user1 === user2 && dispute.user2 === user1)
        );
        
        if (existingDispute) {
            return res.status(400).json({ success: false, message: 'Dispute already exists between these users' });
        }
        
        // Add new dispute
        disputesData.activeDisputes.push({
            user1,
            user2,
            createdAt: new Date().toISOString(),
            id: Date.now().toString()
        });
        
        // Save to file
        fs.writeFileSync('./dispute.json', JSON.stringify(disputesData, null, 2));
        
        console.log(`⚖️ New dispute created between ${user1} and ${user2}`);
        res.json({ success: true, message: 'Dispute created successfully' });
    } catch (error) {
        console.error('Error creating dispute:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to remove dispute
app.post('/api/dispute/remove', (req, res) => {
    try {
        const { user1, user2 } = req.body;
        
        if (!user1 || !user2) {
            return res.status(400).json({ success: false, message: 'Both user IDs are required' });
        }
        
        const disputesData = require('./dispute.json');
        
        // Remove dispute
        const initialLength = disputesData.activeDisputes.length;
        disputesData.activeDisputes = disputesData.activeDisputes.filter(dispute => 
            !((dispute.user1 === user1 && dispute.user2 === user2) ||
              (dispute.user1 === user2 && dispute.user2 === user1))
        );
        
        if (disputesData.activeDisputes.length === initialLength) {
            return res.status(400).json({ success: false, message: 'No dispute found between these users' });
        }
        
        // Save to file
        fs.writeFileSync('./dispute.json', JSON.stringify(disputesData, null, 2));
        
        console.log(`⚖️ Dispute removed between ${user1} and ${user2}`);
        res.json({ success: true, message: 'Dispute removed successfully' });
    } catch (error) {
        console.error('Error removing dispute:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to update verify settings
app.post('/api/verify/settings', (req, res) => {
    try {
        const { verifyChannel, logChannel, category, adminRoles, boyRole, girlRole, embed } = req.body;
        
        if (verifyChannel !== undefined) {
            settings.verifySettings.verifyChannel = verifyChannel;
        }
        if (logChannel !== undefined) {
            settings.verifySettings.logChannel = logChannel;
        }
        if (category !== undefined) {
            settings.verifySettings.category = category;
        }
        if (adminRoles !== undefined) {
            settings.verifySettings.adminRoles = Array.isArray(adminRoles) ? adminRoles : [adminRoles];
        }
        if (boyRole !== undefined) {
            settings.verifySettings.boyRole = boyRole;
        }
        if (girlRole !== undefined) {
            settings.verifySettings.girlRole = girlRole;
        }
        if (embed) {
            settings.verifySettings.embed = { ...settings.verifySettings.embed, ...embed };
        }
        
        // Save to file
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
        
        console.log('✅ Verify settings updated');
        res.json({ success: true, message: 'Verify settings updated' });
    } catch (error) {
        console.error('Error updating verify settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to update temp voice settings
app.post('/api/tempvoice/settings', (req, res) => {
    try {
        const { logChannel, voiceChannel, category, channelName, emojis } = req.body;
        
        if (logChannel !== undefined) {
            settings.tempVoiceSettings.logChannel = logChannel;
        }
        if (voiceChannel !== undefined) {
            settings.tempVoiceSettings.voiceChannel = voiceChannel;
        }
        if (category !== undefined) {
            settings.tempVoiceSettings.category = category;
        }
        if (channelName !== undefined) {
            settings.tempVoiceSettings.channelName = channelName;
        }
        if (emojis !== undefined) {
            settings.tempVoiceSettings.emojis = Array.isArray(emojis) ? emojis : emojis.split(',').map(e => e.trim());
        }
        
        // Save to file
        fs.writeFileSync('./settings.json', JSON.stringify(settings, null, 2));
        
        console.log('🎤 Temp Voice settings updated');
        res.json({ success: true, message: 'Temp Voice settings updated' });
    } catch (error) {
        console.error('Error updating temp voice settings:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// API endpoint to get active verifications
app.get('/api/verify/active', (req, res) => {
    const active = Array.from(activeVerifications.entries()).map(([userId, data]) => ({
        userId,
        claimedBy: data.claimedBy,
        createdAt: data.createdAt
    }));
    
    res.json({ activeVerifications: active });
});

// API endpoint to get active temp voice channels
app.get('/api/tempvoice/active', (req, res) => {
    const active = Array.from(tempVoiceChannels.entries()).map(([channelId, data]) => ({
        channelId,
        ownerId: data.ownerId,
        ownerName: data.ownerName,
        isLocked: data.isLocked,
        userCount: client.channels.cache.get(channelId)?.members?.size || 0,
        createdAt: data.createdAt
    }));
    
    res.json({ activeTempVoices: active });
});

// 404 handler
app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Dashboard available at http://localhost:${PORT}`);
});