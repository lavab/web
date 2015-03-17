module.exports = /*@ngInject*/function($q, $rootScope, $state, $timeout, $window, $translate, consts, LavaboomAPI, co, crypto, cryptoKeys, loader, utils) {
	const self = this;

	const translations = {
		LB_BYE: ''
	};
	$translate.bindAsObject(translations, 'LOADER');

	this.name = '';
	this.styledName = '';
	this.email = '';
	this.nameEmail = '';

	// information about user from API
	this.settings = {};
	this.defaultSettings = {
		isSkipComposeScreenWarning: false,
		isHotkeyEnabled: true,
		isSecuredImages: true
	};

	const setupSettings = (settings) => {
		self.settings = angular.extend({},
			self.defaultSettings,
			settings ? settings : {}
		);
	};

	// primary key
	this.key = null;

	let token = null;
	let isAuthenticated = false;

	const setupUserBasicInformation = (username, styledUsername) => {
		self.name = username;
		self.styledName = styledUsername;
		self.email = `${username}@${consts.ROOT_DOMAIN}`;
		self.nameEmail = `${self.name} <${self.email}>`;

		return username;
	};

	const restoreAuth = () => {
		token = sessionStorage.lavaboomToken ? sessionStorage.lavaboomToken : localStorage.lavaboomToken;

		if (token)
			LavaboomAPI.setAuthToken(token);
	};

	const persistAuth = (isRemember = true) => {
		let storage = isRemember ? localStorage : sessionStorage;
		storage.lavaboomToken = token;
	};

	this.calculateHash = (password) => utils.hexify(openpgp.crypto.hash.sha256(password));

	this.isAuthenticated = () => token && isAuthenticated;

	this.syncKeys = () => co(function *(){
		let res = yield LavaboomAPI.keys.list(self.name);

		let keysByFingerprint = res.body.keys ? res.body.keys.reduce((a, k) => {
			a[k.id] = k;
			return a;
		}, {}) : {};

		let publicKeys = crypto.getAvailablePublicKeysForEmail(self.email);

		let keysCreationPromises = [];

		publicKeys.forEach(key => {
			if (!keysByFingerprint[key.primaryKey.fingerprint]) {
				console.log(`Importing key with fingerprint '${key.primaryKey.fingerprint}' to the server...`);

				keysCreationPromises.push(LavaboomAPI.keys.create(key.armor()));
			} else
				console.log(`Key with fingerprint '${key.primaryKey.fingerprint}' already imported...`);
		});

		yield keysCreationPromises;
	});

	this.authenticate = () => co(function * () {
		restoreAuth();

		let res = yield LavaboomAPI.accounts.get('me');

		setupSettings(res.body.user.settings);
		$rootScope.$broadcast('user-settings');

		setupUserBasicInformation(res.body.user.name, res.body.user.styled_name);

		if (!isAuthenticated) {
			isAuthenticated = true;
			$rootScope.$broadcast('user-authenticated');
		}
	});

	this.gatherUserInformation = () => co(function * () {
		yield self.authenticate();

		yield self.syncKeys();
		if (self.settings.isLavaboomSynced)
			cryptoKeys.importKeys(self.settings.keyring);

		let res = yield LavaboomAPI.keys.get(self.email);
		self.key = res.body.key;

		if (!isAuthenticated) {
			isAuthenticated = true;
			$rootScope.$broadcast('user-authenticated');
		}

		return res.body;
	});

	this.update = (settings) => {
		angular.extend(self.settings, settings);
		return LavaboomAPI.accounts.update('me', {
			settings: self.settings
		});
	};

	this.updatePassword = (oldPassword, newPassword) => co(function *(){
		yield LavaboomAPI.accounts.update('me', {
			current_password: self.calculateHash(oldPassword),
			new_password: self.calculateHash(newPassword)
		});
	});

	this.updateKey = (fingerprint) => co(function * () {
		return yield LavaboomAPI.accounts.update('me', {
			public_key: fingerprint
		});
	});

	this.signIn = (username, password, isRemember, isPrivateComputer) => {
		username = setupUserBasicInformation(username.split('@')[0].trim());

		crypto.initialize({
			isRememberPasswords: isRemember
		});

		return co(function * (){
			try {
				restoreAuth();

				let res = yield LavaboomAPI.tokens.create({
					type: 'auth',
					username: username,
					password: self.calculateHash(password)
				});

				token = res.body.token.id;
				LavaboomAPI.setAuthToken(token);
				persistAuth(isRemember);
				isAuthenticated = true;

				res = yield LavaboomAPI.keys.list(self.name);
				if (!res.body.keys || res.body.keys.length < 1) {
					yield $state.go('generateKeys');
					return;
				}

				// todo: probably we don't need this
				try {
					res = yield LavaboomAPI.keys.get(self.email);
				} catch (err) {
					yield $state.go('generateKeys');
					return;
				}

				self.key = res.body.key;

				res = yield LavaboomAPI.accounts.get('me');
				setupSettings(res.body.user.settings);
				setupUserBasicInformation(res.body.user.name);

				if (self.settings.isLavaboomSynced)
					cryptoKeys.importKeys(self.settings.keyring);

				crypto.options.isPrivateComputer = isPrivateComputer;
				crypto.authenticateByEmail(self.email, password);

				$rootScope.$broadcast('user-authenticated');
			} catch (err) {
				$rootScope.$broadcast('user-authentication-error', err);
				throw err;
			}
		});
	};

	this.removeTokens = () => {
		delete localStorage.lavaboomToken;
		delete sessionStorage.lavaboomToken;
	};

	this.logout = () => {
		$rootScope.$broadcast('logout');

		self.settings = {};
		self.removeTokens();
		crypto.removeSensitiveKeys();

		LavaboomAPI.setAuthToken('');
		isAuthenticated = false;
		token = '';

		loader.resetProgress();
		loader.showLoader(true);
		loader.loadLoginApplication({lbDone: translations.LB_BYE});
	};
};