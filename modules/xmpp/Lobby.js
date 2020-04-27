/* global $ */

import { $iq, $msg, Strophe } from 'strophe.js';
import { getLogger } from 'jitsi-meet-logger';
import XMPPEvents from '../../service/xmpp/XMPPEvents';

const logger = getLogger(__filename);

/**
 * The command type for updating a lobby participant's e-mail address.
 *
 * @type {string}
 */
const EMAIL_COMMAND = 'email';

/**
 * The Lobby room implementation. Setting a room to members only, joining the lobby room
 * approving or denying access to participants from the lobby room.
 */
export default class Lobby {

    /**
     * Constructs lobby room.
     *
     * @param {ChatRoom} room the main room.
     */
    constructor(room) {
        this.xmpp = room.xmpp;
        this.mainRoom = room;
    }

    /**
     * Whether lobby is supported on backend.
     *
     * @returns {boolean} whether lobby is supported on backend.
     */
    isLobbySupported() {
        return Boolean(this.xmpp.lobbyroomComponentAddress);
    }

    /**
     * Enables lobby by setting the main room to be members only and joins the lobby chat room.
     *
     * @param {string} password shared password that can be used to skip lobby room.
     * @returns {Promise}
     */
    enableLobby(password) {
        if (!this.isLobbySupported()) {
            return Promise.reject(new Error('Lobby not supported!'));
        }

        return new Promise((resolve, reject) => {
            this.xmpp.connection.sendIQ(
                $iq({
                    to: this.mainRoom.roomjid,
                    type: 'get'
                }).c('query', { xmlns: 'http://jabber.org/protocol/muc#owner' }),
                res => {
                    if ($(res)
                        .find('>query>x[xmlns="jabber:x:data"]>field[var="muc#roomconfig_membersonly"]').length) {
                        const formsubmit
                            = $iq({
                                to: this.mainRoom.roomjid,
                                type: 'set'
                            }).c('query', { xmlns: 'http://jabber.org/protocol/muc#owner' });

                        formsubmit.c('x', {
                            xmlns: 'jabber:x:data',
                            type: 'submit'
                        });
                        formsubmit
                            .c('field', { 'var': 'FORM_TYPE' })
                            .c('value')
                            .t('http://jabber.org/protocol/muc#roomconfig')
                            .up()
                            .up();
                        formsubmit
                            .c('field', { 'var': 'muc#roomconfig_membersonly' })
                            .c('value')
                            .t('true')
                            .up()
                            .up();

                        if (password) {
                            // TODO make sure this is filtered and removed from form in the prosody module
                            formsubmit
                                .c('field', { 'var': 'muc#roomconfig_lobbypassword' })
                                .c('value')
                                .t(password)
                                .up()
                                .up();
                        }

                        this.xmpp.connection.sendIQ(formsubmit, () => {
                            this.joinLobbyRoom().then(resolve)
                                .catch(reject);
                        }, e => {
                            reject(e);
                        });
                    } else {
                        reject(new Error('Setting members only room not supported!'));
                    }
                },
                e => {
                    reject(e);
                });
        });
    }

    /**
     * Joins a lobby room setting display name and eventually avatar(using the email provided).
     *
     * @param {string} username is required.
     * @param {string} email is optional.
     * @param {string} password is optional for non moderators and should not be passed when moderator.
     * @returns {Promise} resolves once we join the room.
     */
    joinLobbyRoom(displayName, email, password) {
        const isModerator = this.mainRoom.joined && this.mainRoom.isModerator();

        // shared password let's try it
        if (password && !isModerator) {
            return this.mainRoom.join(password);
        }

        const roomName = Strophe.getNodeFromJid(this.mainRoom.roomjid);

        this.lobbyRoom = this.xmpp.createRoom(
            roomName, {
                disableDiscoInfo: true,
                disableFocus: true,
                customDomain: this.xmpp.lobbyroomComponentAddress
            }
        );

        if (displayName) {
            // remove previously set nickname
            this.lobbyRoom.removeFromPresence('nick');
            this.lobbyRoom.addToPresence('nick', {
                attributes: { xmlns: 'http://jabber.org/protocol/nick' },
                value: displayName
            });
        }

        if (isModerator) {
            this.lobbyRoom.addPresenceListener(EMAIL_COMMAND, (node, from) => {
                this.mainRoom.eventEmitter.emit(XMPPEvents.MUC_LOBBY_MEMBER_UPDATED, from, { email: node.value });
            });
            this.lobbyRoom.addEventListener(
                XMPPEvents.MUC_MEMBER_JOINED,
                // eslint-disable-next-line max-params
                (from, nick, role, isHiddenDomain, statsID, status, identity) => {
                    // we emit the new event on the main room so we can propagate
                    // events to the conference
                    this.mainRoom.eventEmitter.emit(
                        XMPPEvents.MUC_LOBBY_MEMBER_JOINED,
                        Strophe.getResourceFromJid(from),
                        nick,
                        identity ? identity.avatar : undefined
                    );
                });
        } else {
            // this should only be handled by those waiting in lobby
            this.lobbyRoom.addEventListener(XMPPEvents.KICKED, isSelfPresence => {
                if (isSelfPresence) {
                    this.mainRoom.eventEmitter.emit(XMPPEvents.MUC_DENIED_ACCESS);

                    this.lobbyRoom.clean();

                    return;
                }
            });

            // As there is still reference of the main room
            // the invite will be detected and addressed to its eventEmitter, even though we are not in it
            // the invite message should be received directly to the xmpp conn in general
            this.mainRoom.addEventListener(
                XMPPEvents.INVITE_MESSAGE_RECEIVED,
                (roomJid, from, txt) => {
                    logger.debug(`Received approval to join ${roomJid} ${from} ${txt}`);
                    if (roomJid === this.mainRoom.roomjid) {
                        // we are now allowed let's join and leave lobby
                        this.mainRoom.join();

                        this.lobbyRoom.leave()
                            .then(() => { })// eslint-disable-line no-empty-function
                            .catch(() => { });// eslint-disable-line no-empty-function
                    }
                });
        }

        return new Promise((resolve, reject) => {
            this.lobbyRoom.addEventListener(XMPPEvents.MUC_JOINED, () => {
                resolve();

                // send our email, as we do not handle this on initial presence we need a second one
                if (email && !isModerator) {
                    this.lobbyRoom.removeFromPresence(EMAIL_COMMAND);
                    this.lobbyRoom.addToPresence(EMAIL_COMMAND, { value: email });
                    this.lobbyRoom.sendPresence();
                }
            });
            this.lobbyRoom.addEventListener(XMPPEvents.ROOM_JOIN_ERROR, reject);
            this.lobbyRoom.addEventListener(XMPPEvents.ROOM_CONNECT_NOT_ALLOWED_ERROR, reject);
            this.lobbyRoom.addEventListener(XMPPEvents.ROOM_CONNECT_ERROR, reject);

            this.lobbyRoom.join();
        });

    }

    /**
     * Should be possible only for moderators.
     * @param id
     */
    denyAccess(id) {
        if (!this.isLobbySupported() || !this.mainRoom.isModerator()) {
            return;
        }

        const jid = Object.keys(this.lobbyRoom.members)
            .find(j => Strophe.getResourceFromJid(j) === id);

        if (jid) {
            this.lobbyRoom.kick(jid);
        } else {
            logger.error(`Not found member for ${jid} in lobby room.`);
        }
    }

    /**
     * Should be possible only for moderators.
     * @param id
     */
    approveAccess(id) {
        if (!this.isLobbySupported() || !this.mainRoom.isModerator()) {
            return;
        }

        const roomJid = Object.keys(this.lobbyRoom.members)
            .find(j => Strophe.getResourceFromJid(j) === id);

        if (roomJid) {
            const jid = this.lobbyRoom.members[roomJid].jid;
            const msgToSend
                = $msg({ to: this.mainRoom.roomjid })
                    .c('x', { xmlns: 'http://jabber.org/protocol/muc#user' })
                    .c('invite', { to: jid });

            this.xmpp.connection.sendIQ(msgToSend,
                () => { }, // eslint-disable-line no-empty-function
                e => {
                    logger.error(`Error sending invite for ${jid}`, e);
                });
        } else {
            logger.error(`Not found member for ${roomJid} in lobby room.`);
        }
    }
}
