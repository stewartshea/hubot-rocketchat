// Hubot adapter for Rocket.Chat
// For configuration and deployment details, see https://github.com/RocketChat/hubot-rocketchat/blob/master/README.md
//
// The RocketChatBotAdapter class implements 'standard' hubot Adapter interface methods.
//
// Most of the Rocket.Chat specific code, tied to Rocket.Chat's real-time messaging APIs, are isolated in
// a seperate RocketChatDriver class.

/*try {
	import {Robot, Adapter, TextMessage, EnterMessage, User, Response} from 'hubot';
} catch (error) {
	import prequire from 'parent-require';
	import {Robot, Adapter, TextMessage, EnterMessage, User, Response} from prequire('hubot');
}*/

import {Robot, Adapter, TextMessage, EnterMessage, User, Response} from 'hubot';

import Q from 'q';
import Chatdriver from './rocketchat_driver';

const RocketChatURL = process.env.ROCKETCHAT_URL || "localhost:3000";
const RocketChatRoom = process.env.ROCKETCHAT_ROOM || "GENERAL";
const RocketChatUser = process.env.ROCKETCHAT_USER || "hubot";
const RocketChatPassword = process.env.ROCKETCHAT_PASSWORD || "password";
const ListenOnAllPublicRooms = process.env.LISTEN_ON_ALL_PUBLIC || "false";
const RespondToDirectMessage = process.env.RESPOND_TO_DM || "false";
let SSLEnabled = "false";

// Custom Response class that adds a sendPrivate and sendDirect method
class RocketChatResponse extends Response {
	sendDirect(...strings) {
		return this.robot.adapter.sendDirect(this.envelope, ...strings);
	}
	sendPrivate(...strings) {
		return this.robot.adapter.sendDirect(this.envelope, ...strings);
	}
}

class RocketChatBotAdapter extends Adapter {

	constructor(...args) {
		super(...args);
		this.run = this.run.bind(this);
	}

	run() {
		this.robot.logger.info("Starting Rocketchat adapter...");

		this.robot.logger.info(`Once connected to rooms I will respond to the name: ${this.robot.name}`);

		if (!process.env.ROCKETCHAT_URL) { this.robot.logger.warning(`ROCKETCHAT_URL unset, using: ${RocketChatURL}`); }
		if (!process.env.ROCKETCHAT_ROOM) { this.robot.logger.warning(`No services ROCKETCHAT_ROOM unset, using: ${RocketChatRoom}`); }
		if (!process.env.ROCKETCHAT_USER) { this.robot.logger.warning(`No services ROCKETCHAT_USER unset, using: ${RocketChatUser}`); }
		if (!RocketChatPassword) { return this.robot.logger.error("ROCKETCHAT_PASSWORD unset"); }

		this.robot.Response = RocketChatResponse;

		if (RocketChatURL.toLowerCase().match(/^https/)) {
			this.robot.logger.info('Using SSL for connection');
			SSLEnabled = true;
		}

		this.lastts = new Date();

		this.robot.logger.info(`Connecting To: ${RocketChatURL}`);

		let room_ids = null;
		let userid = null;

		this.chatdriver = new Chatdriver(RocketChatURL, SSLEnabled, this.robot.logger, () => {
			this.robot.logger.info("Successfully connected!");
			this.robot.logger.info(RocketChatRoom);

			let rooms = RocketChatRoom.split(',');
			// @robot.logger.info JSON.stringify(rooms)

			// Log in
			this.chatdriver.login(RocketChatUser, RocketChatPassword)
      		.catch(loginErr => {})
      		// Get room IDS
      		.then(_userid => {
				userid = _userid;
				this.robot.logger.info("Successfully Logged In");
				let roomids = [];
				for (let i = 0; i < rooms.length; i++) {
					roomids.push(this.chatdriver.getRoomId(rooms[i]));
				}

				return Q.all(roomids)
				.catch(roomErr => {
					this.robot.logger.error(`Unable to get room id: ${JSON.stringify(roomErr)} Reason: ${roomErr.reason}`);
					throw roomErr;
				});
			})
			// Join all specified rooms
			.then(_room_ids => {
				room_ids = _room_ids;
				let joinrooms = [];
				for (let index = 0; index < room_ids.length; index++) {
					let result = room_ids[index];
					rooms[index] = result;
					joinrooms.push(this.chatdriver.joinRoom(userid, RocketChatUser, result));
				}

				this.robot.logger.info("rid: ", room_ids);
				return Q.all(joinrooms)
				.catch(joinErr => {
					this.robot.logger.error(`Unable to Join room: ${JSON.stringify(joinErr)} Reason: ${joinErr.reason}`);
					throw joinErr;
				});
			})

			// Subscribe to msgs in all rooms
			.then(res => {
				this.robot.logger.info("All rooms joined.");
				let subs = [];
				for (let idx = 0; idx < res.length; idx++) {
					let result = res[idx];
					this.robot.logger.info(`Successfully joined room: ${rooms[idx]}`);
					subs.push(this.chatdriver.prepMeteorSubscriptions({uid: userid, roomid: rooms[idx]}));
				}

				return Q.all(subs)
				.catch(subErr => {
					this.robot.logger.error(`Unable to subscribe: ${JSON.stringify(subErr)} Reason: ${subErr.reason}`);
					throw subErr;
				});
			})

			// Setup msg callbacks
			.then(results => {
				this.robot.logger.info("All subscriptions ready.");
				for (let idx = 0; idx < results.length; idx++) {
					let result = results[idx];
					this.robot.logger.info(`Successfully subscribed to room: ${rooms[idx]}`);
				}

				return this.chatdriver.setupReactiveMessageList(newmsg => {
					if ((newmsg.u._id !== userid) || (newmsg.t === 'uj')) {
						if ((__in__(newmsg.rid, room_ids))	|| (ListenOnAllPublicRooms.toLowerCase() === 'true') ||	((RespondToDirectMessage.toLowerCase() === 'true') && (newmsg.rid.indexOf(userid) > -1))) {
							let curts = new Date(newmsg.ts.$date);
							this.robot.logger.info(`Message receive callback id ${newmsg._id} ts ${curts}`);
							this.robot.logger.info(`[Incoming] ${newmsg.u.username}: ${newmsg.msg}`);

							if (curts > this.lastts) {
								this.lastts = curts;
								if (newmsg.t !== 'uj') {
									var user = this.robot.brain.userForId(newmsg.u._id, {name: newmsg.u.username, room: newmsg.rid});
									let text = new TextMessage(user, newmsg.msg, newmsg._id);
									this.robot.receive(text);
									return this.robot.logger.info("Message sent to hubot brain.");
								} else {	 // enter room message
									if (newmsg.u._id !== userid) {
										var user = this.robot.brain.userForId(newmsg.u._id, {name: newmsg.u.username, room: newmsg.rid});
										return this.robot.receive(new EnterMessage(user, null, newmsg._id));
									}
								}
							}
						}
					}
				});
			})

			.then(() => {
				return this.emit('connected');
			})
			// Final exit, all throws skip to here
			.catch(err => {
				this.robot.logger.error(JSON.stringify(err));
				return this.robot.logger.error("Unable to complete setup. See https://github.com/RocketChat/hubot-rocketchat for more info.");
			});
		});
	}

	send(envelope, ...strings) {
		return this.chatdriver.sendMessage(strings, envelope.room);
	}

	customMessage(data) {
		return this.chatdriver.customMessage(data);
	}

	sendDirect(envelope, ...strings) {
		let channel = this.chatdriver.getDirectMessageRoomId(envelope.user.name);
		return Q(channel)
		.then(chan => {
			envelope.room = chan.rid;
			return this.chatdriver.sendMessageByRoomId(strings, envelope.room);
		})
		.catch(err => {
			return this.robot.logger.error(`Unable to get DirectMessage Room ID: ${JSON.stringify(err)} Reason: ${err.reason}`);
		});
	}

	reply(envelope, ...strings) {
		this.robot.logger.info("reply");
		strings = strings.map(s => `@${envelope.user.name} ${s}`);
		return this.send(envelope, strings);
	}

	callMethod(method, ...args) {
		return this.chatdriver.callMethod(method, args);
	}
}

export function use(robot) {
	return new RocketChatBotAdapter(robot);
}

function __in__(needle, haystack) {
  return haystack.indexOf(needle) >= 0;
}
