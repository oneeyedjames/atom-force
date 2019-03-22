'use babel';

import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import archiver from 'archiver';
import unzipper from 'unzipper';
import xml from 'xml';
import xml2js from 'xml2js';
import co from 'co';
import nforce from 'nforce';
import addNforceTooling from 'nforce-tooling';
import addNforceMetadata from 'nforce-metadata';
addNforceTooling(nforce); // better ES6y way to import these?
addNforceMetadata(nforce);
import log from './log.js';

const CLIENT_ID = '3MVG9xOCXq4ID1uHM155ZfXCXD8FgKFU8zNRnyt3JS07eYXfuhyjwlV0iw.BOS8mS6os74WuS.xCLXM_kG7un';
const XMLNS = 'http://soap.sforce.com/2006/04/metadata';

const EXT_TO_TYPE = {
	cls: 'ApexClass',
	trigger: 'ApexTrigger',
	apxt: 'ApexTrigger',
	page: 'ApexPage',
	resource: 'StaticResource',
};

const EXT_TO_FOLDER = {
	cls: 'classes',
	trigger: 'triggers',
	apxt: 'classes',
	page: 'pages',
	resource: 'staticresources',
};

const POLL_INTERVAL = 500; // ms to wait in between polling for status. TODO make this configurable

// use nforce to save stuff (and eventually do other stuff), and emit events.
export default class SfConnection extends EventEmitter {
	constructor(oauth, environment) {
		console.log(`env ${environment}`);
		super();
		const loginSubDomain = environment === 'sandbox' ? 'test' : 'login';
		this.org = nforce.createConnection({
			clientId: CLIENT_ID,
			redirectUri: `https://${loginSubDomain}.salesforce.com/services/oauth2/success`,
			mode: 'single',
			plugins: ['tooling', 'meta'],
			autoRefresh: true,
			environment,
			oauth,
			metaOpts: {}, // metadata operations fail without this
		});
		this.entityIdCache = {};
		this.reqs = 0;
		console.log(this.org);
	}

	emit(type, ...args) {
		super.emit(type, ...args);
		console.log(`SfConnection emitted ${type} with args ${JSON.stringify(args)}`);
	}

	// expose this nforce method so that our main AtomForce class can easily get the right URL
	getAuthUri() {
		return this.org.getAuthUri({
			responseType: 'token',
			scope: ['full', 'refresh_token'],
		});
	}

	_mkdir(filename) {
		var dirname = path.dirname(filename);

		if (fs.existsSync(dirname)) return;

		this._mkdir(dirname);
		fs.mkdirSync(dirname);
	}

	retrieveMetadata(rootDir, package) {
		const org = this.org;
		const arc = archiver('zip');

		var retrieveOptions = {
			apiVersion: package.version[0],
			unpackaged: {
				version: package.version[0],
				types: []
			}
		};

		package.types.forEach(type => {
			retrieveOptions.unpackaged.types.push({
				name: type.name[0],
				members: type.members
			});
		});

		const retrievePromise = org.meta.retrieveAndPoll(retrieveOptions);

		retrievePromise.poller.on('start', () => this.emit('saveRetreive', this.org.oauth));
		retrievePromise.poller.on('poll', (stat) => console.log(stat));
		retrievePromise.poller.on('done', () => this.emit('saveComplete', 'Retrieval Complete'));
		retrievePromise.then(res => {
			var buff = new Buffer(res.zipFile, 'base64');

			unzipper.Open.buffer(buff).then(res => {
				res.files.forEach(file => {
					console.log(file);

					var relpath = file.path;
					if (relpath.startsWith('unpackaged/'))
						relpath = relpath.substr(11);

					var abspath = rootDir + '/src/' + relpath;
					this._mkdir(abspath);

					file.stream()
					.pipe(fs.createWriteStream(abspath))
					.on('finish', () => {
						var chksumPath = rootDir + '/.checksum/' + relpath + '.crc32';
						this._mkdir(chksumPath);
						fs.writeFile(chksumPath, file.crc32, err => {});
					});
				});
			});
		}).error(err => {
			this.emit('retrieveFailed', err);
			console.error(err);
		});
	}

	// Will read the given paths and deploy them to a target organization via metadata API
	deployMetadata(paths, tests) {
		const org = this.org;
		const allFilenames = [];
		const arc = archiver('zip');

		paths.forEach(filePath => {
			const name = path.basename(filePath);
			const [,, extension] = SfConnection._parseApexName(name);
			const folder = `src/${EXT_TO_FOLDER[extension]}`;
			console.log(`saw ${filePath}`);
			arc.file(filePath, { name, prefix: folder });
			arc.file(`${filePath}-meta.xml`, { name: `${name}-meta.xml`, prefix: folder });
			allFilenames.push(name);
		});

		const packageXml = SfConnection._createPackageXml(allFilenames);
		console.log(packageXml);
		arc.append(packageXml, { name: 'package.xml', prefix: 'src' });
		arc.finalize();
		console.log('done preparing zip');

		const deployOptions = { rollbackOnError: true };
		if (tests) {
			const runTests = tests.split(',');
			Object.assign(deployOptions, { runTests, testLevel: 'RunSpecifiedTests' });
		}
		console.log(`deployOptions: ${JSON.stringify(deployOptions)}`);

		const deployPromise = org.meta.deployAndPoll({
			deployOptions,
			zipFile: arc,
		});
		deployPromise.poller.on('start', () => this.emit('saveDeploy', this.org.oauth));
		deployPromise.poller.on('poll', (stat) => console.log(stat));
		deployPromise.poller.on('done', () => this.emit('saveComplete', 'Deployment complete!'));

		deployPromise.error(err => { // TODO extract something form this err msg.
			this.emit('deployFailed', err);
			console.error(JSON.stringify(err));
			console.error(err);
		});
	}

	// possible TODO: seem to keep parsing filenames, wrap this stuff in its own class?
	static _createPackageXml(filenames) { // return a string of xml.
		const members = new Map(); // first sort all our members into their appropriate types
		filenames.forEach(filename => {
			const [, name, extension] = SfConnection._parseApexName(filename);
			const type = EXT_TO_TYPE[extension];

			if (!members.has(type)) {
				members.set(type, [name]);
			} else {
				members.get(type).push(name);
			}
		});

		const pkg = { Package: [{ _attr: { xmlns: XMLNS } }, { version: '36.0' }] };
		for (const [type, memberNames] of members) {
			const children = [];
			memberNames.forEach(name => {
				children.push({ members: name });
			});

			children.push({ name: type });
			pkg.Package.push({ types: children });
		}
		console.log(pkg);
		return xml(pkg, { declaration: true });
	}

	saveTooling(fullPath, body) {
		if (this.isSaving) { // handles case when user has the same file open in multiple tabs
			return;
		}
		this.isSaving = true;
		const fullName = path.basename(fullPath);
		const [, name, extension] = SfConnection._parseApexName(fullName);
		const type = EXT_TO_TYPE[extension];

		this.emit('saveTooling', fullName);
		if (type === 'StaticResource') {
			this._saveToolingOther(fullName, name, type, body);
		} else {
			this._saveToolingApex(fullPath, name, type, body);
		}
	}

	static _parseApexName(fullName) {
		return /^(\w+)\.(cls|page|trigger|resource)/.exec(fullName);
	}

	// this is primarily intended for StaticResource
	_saveToolingOther(fullName, name, type, body) {
		this._getEntityId(fullName, name, type)
		.then((id) => {
			this.org.tooling.update({
				id,
				type,
				object: { name, body: new Buffer(body).toString('base64') },
			});
		})
		.then(() => {
			this.emit('saveComplete', fullName);
			this.isSaving = false;
		}).catch(err => {
			this.emit('saveError', err);
			this.isSaving = false;
		});
	}

	/* Save any apex code - VF, class, or trigger.
	 * This way more complicated than above: we have to:
	 *  (0. be authenticated)
	 *  1. get the class Id if we don't have it and save it - _getEntityId
	 *  2. create a container - _getContainer
	 *  3. tell SF to add our class to that container - addContainerArtifact
	 *  4. tell SF to deploy
	 *  5. poll on the result
	 *  6. delete our container. once your class saves successfully in a container,
	 *     you can't deploy it with that container again, so it seems best to just always
	 *     delete it.
	 *     maybe in the future this class can remember which files you have tried and failed to save.
	 * this fn uses co() simply to make it more readable */
	_saveToolingApex(fullPath, name, type, body) {
		const t = this.org.tooling;
		const fullName = path.basename(fullPath);
		co(function* asyncDeploy() {
			const [containerId, contentEntityId] =
					yield [this._getContainer(), this._getEntityId(fullName, name, type)];

			const artifact = t.createDeployArtifact(`${type}Member`, { body, contentEntityId });
			yield t.addContainerArtifact({ id: containerId, artifact });
			const { id: asyncContainerId } =
					yield t.deployContainer({ id: this.containerId, isCheckOnly: false });

			yield this._pollOnToolingDeploy(asyncContainerId);
			yield this._deleteContainer();
			this.emit('saveComplete', fullName);
		}.bind(this)).catch(err => {
			if (err.State === 'Failed') {
				this.emit('saveFailed', fullPath, err.DeployDetails.componentFailures[0]);
			} else if (err.State === 'Error') {
				this.emit('saveError', fullName, err.ErrorMsg
					? err.deployStatus.ErrorMsg
					: 'unknown error');
			} else {
				this.emit('saveError', fullName, err);
			}
			this._deleteContainer();
		});
	}

	// just create a promise and pass off the info.
	_pollOnToolingDeploy(asyncContainerId) {
		return new Promise((resolve, reject) => {
			this._pollOnToolingDeployInner(asyncContainerId, resolve, reject);
		});
	}

	/* for readability mainly we want to chain these polls using setTimeout, and we need a way
	 * to call this part directly without creating a new promise every time.
	 * I think there's a better and clearer way to do this... */
	_pollOnToolingDeployInner(asyncContainerId, resolve, reject) {
		this.org.tooling.getContainerDeployStatus({ id: asyncContainerId }).then((deployStatus) => {
			console.log(`polling; state: ${deployStatus.State}`);
			if (deployStatus.State === 'Queued') {
				setTimeout(() => this._pollOnToolingDeployInner(asyncContainerId, resolve, reject), POLL_INTERVAL);
			} else if (deployStatus.State === 'Completed') {
				resolve();
			} else {
				reject(deployStatus);
			}
		}).catch(err => { reject(JSON.stringify(err)); });
	}

	// - get and remember container. (for now) we should only ever have one open at a time.
	// - create a metadatacontainer for this user. assumption is that only one save will be happening
	// at a time per user. that might not be a safe assumption.
	// - this way, it can be deleted anytime on failure without blowing anything else up.
	_getContainer() {
		const userId = this.org.oauth.id.slice(-18);
		return this.org.tooling.createContainer({ name: `atom-force-${userId}` })
			.then(({ id }) => {
				this.containerId = id;
				return id;
			})
			.catch(err => {
				if (err.toString().indexOf('duplicate value found') > -1) {
					const id = err.toString().slice(-15);
					this.containerId = id;
					return this._deleteContainer().then(() =>
						this._getContainer());
				}

				console.error(err);
				throw err;
			});
	}

	// get and remember the Id of a given apex (class|page|trigger).
	_getEntityId(fullName, name, type) {
		if (this.entityIdCache[fullName]) {
			return Promise.resolve(this.entityIdCache[fullName]);
		}

		return this.org.tooling.query({ q: `SELECT Id FROM ${type} WHERE Name = '${name}'` })
		.then(({ records: [{ Id: id }] }) => {
			this.entityIdCache[fullName] = id;
			return id;
		});
	}

	_deleteContainer() {
		if (this.containerId) {
			return this.org.tooling.deleteContainer({ id: this.containerId })
			.then(() => {
				this.containerId = null;
				this.isSaving = false;
			});
		}

		return Promise.resolve(null);
	}
}
