module.exports = /*@ngInject*/function($q, $rootScope, $timeout, router, consts, co, LavaboomAPI, user, crypto, contacts, Cache, Email, Thread, Label) {
	var self = this;

	var defaultCacheOptions = {
		ttl: consts.INBOX_THREADS_CACHE_TTL
	};
	var cacheOptions = angular.extend({}, defaultCacheOptions, {
		ttl: consts.INBOX_EMAILS_CACHE_TTL,
		isInvalidateWholeCache: true
	});
	var threadsCaches = [];
	var emailsListCache = new Cache(defaultCacheOptions);

	this.invalidateThreadCache = () => {
		for(let labelName of Object.keys(threadsCaches)) {
			console.log('invalidate thread cache for label', labelName, '...');
			threadsCaches[labelName].invalidateAll();
		}
	};

	this.invalidateEmailCache = () => {
		console.log('invalidate email cache...');
		emailsListCache.invalidateAll();
	};

	var handleEvent = (event) => co(function *(){
		console.log('got server event', event);

		var labelNames = event.labels.map(lid => self.labelsById[lid].name);
		labelNames.forEach(labelName => {
			threadsCaches[labelName].invalidateAll();
			self.labelsByName[labelName].addUnreadThreadId(event.thread);
		});

		if (labelNames.includes(self.labelName)) {
			var thread = yield self.getThreadById(event.thread);
			self.threads[thread.id] = thread;
			self.threadsList.unshift(thread);
			self.threadsList = _.uniq(self.threadsList, t => t.id);
		}
	});

	var deleteThreadLocally = (threadId) => {
		if (self.threads[threadId]) {
			delete self.threads[threadId];
			self.threadsList.splice(self.threadsList.findIndex(thread => thread.id == threadId), 1);
		}
	};

	var performsThreadsOperation = (operation) => co(function *() {
		var currentLabelName = self.labelName;

		var r = yield operation;

		$rootScope.$broadcast(`inbox-threads`, currentLabelName);

		return r;
	});

	//ToDo: manifest for each thread(subject and other meta data)
	var getThreadsByLabelName = (labelName) => co(function *() {
		var label = self.labelsByName[labelName];

		var threads = (yield LavaboomAPI.threads.list({
			label: label.id,
			attachments_count: true,
			sort: '-date_modified',
			offset: self.offset,
			limit: self.limit
		})).body.threads;

		var result = {
			list: [],
			map: {}
		};

		if (threads) {
			result = (yield threads.map(t => co.def(Thread.fromEnvelope(t), (e) => {console.log(e.stack);return null;}))).reduce((a, t) => {
				console.log('t', t);
				if (t) {
					a.map[t.id] = t;
					a.list.push(t);
				}
				return a;
			}, result);
		}

		return result;
	});

	this.getThreadById = (threadId) => co(function *() {
		var thread = (yield LavaboomAPI.threads.get(threadId)).body.thread;

		return thread ? yield Thread.fromEnvelope(thread) : null;
	});

	this.requestDelete = (threadId) => performsThreadsOperation(co(function *() {
		var thread = self.threads[threadId];
		var trashLabelId = self.labelsByName.Trash.id;
		var spamLabelId = self.labelsByName.Spam.id;
		var draftsLabelId = self.labelsByName.Drafts.id;

		threadsCaches[self.labelName].invalidateAll();

		var r;
		var lbs = thread.labels;
		if (lbs.includes(trashLabelId) || lbs.includes(spamLabelId) || lbs.includes(draftsLabelId))
			r = yield LavaboomAPI.threads.delete(threadId);
		else
			r = yield self.requestSetLabel(threadId, 'Trash');

		deleteThreadLocally(threadId);

		return r;
	}));

	this.requestSetLabel = (threadId, labelName) => performsThreadsOperation(co(function *() {
		var currentLabelName = self.labelName;

		var labelId = self.labelsByName[labelName].id;

		for(let c of Object.keys(threadsCaches))
			threadsCaches[c].invalidateAll();

		var r =  yield LavaboomAPI.threads.update(threadId, {labels: [labelId]});

		if (labelName != currentLabelName)
			deleteThreadLocally(threadId);

		return r;
	}));

	this.requestSwitchLabel = (threadId, labelName) => performsThreadsOperation(co(function *() {
		var thread = self.threads[threadId];

		if (thread.isLabel(labelName)) {
			console.log('label found - remove');

			thread.labels.forEach(lid =>
				threadsCaches[self.labelsById[lid].name].invalidateAll()
			);

			var newLabels = thread.removeLabel(labelName);
			var r = yield LavaboomAPI.threads.update(threadId, {labels: newLabels});

			if (self.labelName == 'Starred')
				deleteThreadLocally(threadId);

			thread.labels = newLabels;
			return r;
		} else {
			console.log('label not found - add');
			return yield self.requestAddLabel(threadId, labelName);
		}
	}));

	this.requestAddLabel = (threadId, labelName) => performsThreadsOperation(co(function *() {
		var thread = self.threads[threadId];

		threadsCaches[labelName].invalidateAll();

		var newLabels = thread.addLabel(labelName);
		var r = yield LavaboomAPI.threads.update(threadId, {labels: newLabels});

		thread.labels = newLabels;
		return r;
	}));

	this.getEmailsByThreadId = (threadId) => emailsListCache.call(
		(threadId) => co(function *() {
			var emails = (yield LavaboomAPI.emails.list({thread: threadId})).body.emails;

			return yield (emails ? emails : []).map(e => Email.fromEnvelope(e));
		}),
		[threadId]
	);

	this.setThreadReadStatus = (threadId) => co(function *(){
		if (self.threads[threadId].isRead)
			return;

		yield LavaboomAPI.threads.update(threadId, {
			is_read: true,
			labels: self.threads[threadId].labels
		});

		self.threads[threadId].isRead = true;

		var labels = yield self.getLabels();
		self.labelsByName = labels.byName;
		self.labelsById = labels.byId;

		$rootScope.$broadcast('inbox-labels');
	});

	this.getLabels = () => co(function *() {
		var labels = (yield LavaboomAPI.labels.list()).body.labels;

		threadsCaches = [];
		return labels.reduce((a, label) => {
			threadsCaches[label.name] = new Cache(cacheOptions);
			a.byName[label.name] = a.byId[label.id] = new Label(label);
			return a;
		}, {byName: {}, byId: {}});
	});

	this.initialize = () => co(function *(){
		self.offset = 0;
		self.limit = 15;
		self.emails = [];
		self.selected = null;

		self.labelName = '';
		self.labelsById = {};
		self.labelsByName = {};
		self.threads = {};
		self.threadsList = [];

		var labels = yield self.getLabels();

		if (!labels.byName.Drafts) {
			yield LavaboomAPI.labels.create({name: 'Drafts'});
			labels = yield self.getLabels();
		}

		self.labelsByName = labels.byName;
		self.labelsById = labels.byId;

		$rootScope.$broadcast('inbox-labels');

		yield self.requestList('Inbox');
	});

	this.downloadAttachment = (id) => co(function *(){
		let res =  yield LavaboomAPI.files.get(id);
		return (yield crypto.decodeEnvelope(res.body.file, '', 'raw')).data;
	});

	this.uploadAttachment = (envelope) => co(function *(){
		return yield LavaboomAPI.files.create(envelope);
	});

	this.deleteAttachment = (attachmentId) => co(function *(){
		return yield LavaboomAPI.files.delete(attachmentId);
	});

	this.getEmailById = (emailId) => co(function *(){
		var r = yield LavaboomAPI.emails.get(emailId);

		return r.body.email ? Email.fromEnvelope(r.body.email) : null;
	});

	this.requestList = (labelName) => {
		if (self.labelName != labelName) {
			self.offset = 0;
			self.threads = {};
			self.threadsList = [];
		}

		self.labelName = labelName;

		return performsThreadsOperation(co(function * (){
			var e = yield threadsCaches[labelName].call(() => getThreadsByLabelName(labelName), [self.offset, self.limit]);

			if (e.list.length > 0)
				self.offset += e.list.length;

			self.threads = angular.extend(self.threads, e.map);
			self.threadsList = _.uniq(self.threadsList.concat(e.list), t => t.id);

			return e;
		}));
	};

	this.getKeyForEmail = (email) => co(function * () {
		var r = yield LavaboomAPI.keys.get(email);
		return r.body.key;
	});

	var sendEnvelope = null;

	this.send = (opts, manifest, keys) => co(function * () {
		sendEnvelope = yield Email.toEnvelope(opts, manifest, keys);

		return {
			isEncrypted: sendEnvelope.kind == 'manifest'
		};
	});

	this.confirmSend = () =>  co(function * () {
		var res = yield LavaboomAPI.emails.create(sendEnvelope);

		sendEnvelope = null;

		return res.body.id;
	});

	this.rejectSend = () => {
		sendEnvelope = null;
	};

	$rootScope.whenInitialized(() => {
		LavaboomAPI.subscribe('receipt', (msg) => performsThreadsOperation(handleEvent(msg)));
		LavaboomAPI.subscribe('delivery', (msg) => performsThreadsOperation(handleEvent(msg)));

		$rootScope.$on('logout', () => {
			self.invalidateEmailCache();
			self.invalidateThreadCache();
		});
	});
};