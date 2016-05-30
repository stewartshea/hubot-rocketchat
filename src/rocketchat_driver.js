// Adding some documentation
// Adding something else

import Asteroid from 'asteroid';
import Q from 'q';
import LRU from 'lru-cache';

// TODO: need to grab these values from process.env[]

let _msgsubtopic = 'stream-messages'; // 'messages'
let _msgsublimit = 10;   // this is not actually used right now
let _messageCollection = 'stream-messages';

// room id cache
let _roomCacheSize = parseInt(process.env.ROOM_ID_CACHE_SIZE) || 10;
let _directMessageRoomCacheSize = parseInt(process.env.DM_ROOM_ID_CACHE_SIZE) || 100;
let _cacheMaxAge = parseInt(process.env.ROOM_ID_CACHE_MAX_AGE) || 300;
let _roomIdCache = LRU( {max: _roomCacheSize, maxAge: 1000 * _cacheMaxAge} );
let _directMessageRoomIdCache = LRU( {max: _directMessageRoomCacheSize, maxAge: 1000 * _cacheMaxAge} );

// driver specific to Rocketchat hubot integration
// plugs into generic rocketchatbotadapter

class RocketChatDriver {
	constructor(url, ssl, logger, cb) {
		this.getRoomId = this.getRoomId.bind(this);
		this.getDirectMessageRoomId = this.getDirectMessageRoomId.bind(this);
		this.tryCache = this.tryCache.bind(this);
		this.joinRoom = this.joinRoom.bind(this);
		this.sendMessage = this.sendMessage.bind(this);
		this.sendMessageByRoomId = this.sendMessageByRoomId.bind(this);
		this.customMessage = this.customMessage.bind(this);
		this.login = this.login.bind(this);
		this.prepMeteorSubscriptions = this.prepMeteorSubscriptions.bind(this);
		this.setupReactiveMessageList = this.setupReactiveMessageList.bind(this);
		this.callMethod = this.callMethod.bind(this);
		this.logger = logger;
		if (ssl ===  'true') {
			var sslenable = true;
		} else {
			var sslenable = false;
		}

		this.asteroid = new Asteroid(url, sslenable);

		this.asteroid.on('connected', () => cb());
	}

	getRoomId(room) {
		return this.tryCache(_roomIdCache, 'getRoomIdByNameOrId', room, 'Room ID');
	}

	getDirectMessageRoomId(username) {
		return this.tryCache(_directMessageRoomIdCache, 'createDirectMessage', username, 'DM Room ID');
	}

	tryCache(cacheArray, method, key, name) {
		if (typeof name === 'undefined' || name === null) { name = method; }
		let cached = cacheArray.get(key);
		if (cached) {
			this.logger.debug(`Found cached ${name} for ${key}: ${cached}`);
			return Q(cached);
		} else {
			this.logger.info(`Looking up ${name} for: ${key}`);
			let r = this.asteroid.call(method, key);
			return r.result.then(res => {
				cacheArray.set(key, res);
				return Q(res);
			});
		}
	}

	joinRoom(userid, uname, roomid, cb) {
		this.logger.info(`Joining Room: ${roomid}`);

		let r = this.asteroid.call('joinRoom', roomid);

		return r.updated;
	}

	sendMessage(text, room) {
		this.logger.info(`Sending Message To Room: ${room}`);
		let r = this.getRoomId(room);
		return r.then(roomid => {
			return this.sendMessageByRoomId(text, roomid);
		});
	}

	sendMessageByRoomId(text, roomid) {
		return this.asteroid.call('sendMessage', {msg: text, rid: roomid})
		.then(function(result){
			return this.logger.debug('[sendMessage] Success:', result);
		})
		.catch(function(error) {
			return this.logger.error('[sendMessage] Error:', error);
		});
	}

	customMessage(message) {
		this.logger.info(`Sending Custom Message To Room: ${message.channel}`);

		return this.asteroid.call('sendMessage', {msg: "", rid: message.channel, attachments: message.attachments, bot: true, groupable: false});
	}

	login(username, password) {
		this.logger.info("Logging In");
		// promise returned
		if (process.env.ROCKETCHAT_AUTH === 'ldap') {
			return this.asteroid.login({
				username,
				ldapPass: password,
				ldapOptions: {}
			});
		} else {
			return this.asteroid.loginWithPassword(username, password);
		}
	}

	prepMeteorSubscriptions(data) {
		// use data to cater for param differences - until we learn more
		//  data.uid
		//  data.roomid
		// return promise
		this.logger.info("Preparing Meteor Subscriptions..");
		let msgsub = this.asteroid.subscribe(_msgsubtopic, data.roomid, _msgsublimit);
		this.logger.info(`Subscribing to Room: ${data.roomid}`);
		return msgsub.ready;
	}

	setupReactiveMessageList(receiveMessageCallback) {
		this.logger.info("Setting up reactive message list...");
		this.messages = this.asteroid.getCollection(_messageCollection);

		let rQ = this.messages.reactiveQuery({});
		return rQ.on("change", id => {
			// awkward syntax due to asteroid limitations
			// - it ain't no minimongo cursor
			// @logger.info "Change received on ID " + id
			let changedMsgQuery = this.messages.reactiveQuery({"_id": id});
			if (changedMsgQuery.result && changedMsgQuery.result.length > 0) {
				// console.log('result:', JSON.stringify(changedMsgQuery.result, null, 2))
				let changedMsg = changedMsgQuery.result[0];
				// console.log('changed:', JSON.stringify(changedMsg, null, 2));
				if (changedMsg.args != null) {
					this.logger.info(`Message received with ID ${id}`);
					return receiveMessageCallback(changedMsg.args[1]);
				}
			}
		});
	}

	callMethod(name, args = []) {
		this.logger.info(`Calling: ${name}, ${args.join(', ')}`);
		let r = this.asteroid.apply(name, args);
		return r.result;
	}
}

export default RocketChatDriver;
