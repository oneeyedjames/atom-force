'use babel';

import fs from 'fs';
import path from 'path';
import EventEmitter from 'events';
import xml2js from 'xml2js';
import SfConnection from './atom-nforce.js';

// Manage remembering tokens + data related to user's SF projects.
export default class SfProject extends EventEmitter {
	constructor(projRoot) { // path should be root dir of user's project
		super();
		this.projRoot = projRoot;
		this.projectFilePath = path.join(`${this.projRoot}`, '.atomforce');
		this._getPackage().then(result => {
			this.package = result.Package;
		});
	}

	getPrimaryConnection() {
		return this._getPrimaryData().then(({ oauth, env }) => new SfConnection(oauth, env));
	}

	// Look in user's root directory for projectFilePath (hardcoded as [root]/.atomforce right now)
	_getPrimaryData() {
		if (this.projectData) {
			return Promise.resolve(
				{ oauth: this.projectData.primary.oauth, env: this.projectData.primary.env });
		}

		return new Promise((resolve, reject) =>
			fs.readFile(this.projectFilePath, (err, data) => {
				if (err) {
					console.error(err);
					reject(null);
				} else {
					const parsed = JSON.parse(data);
					if (parsed.primary) {
						this.emit('projectLoaded', 'Successfully loaded Force.com project data.');
						this.projectData = parsed;
						resolve({ oauth: this.projectData.primary.oauth, env: this.projectData.primary.env });
					} else {
						reject(`didn't find a primary org: data dump: ${data})`);
					}
				}
			}));
	}

	addOrg(name, oauth, env) {
		this.projectData.others.push({ name, env, oauth });
		this._write();
	}

	getOrgs() {
		return [this.projectData.primary, ...this.projectData.others];
	}

	setPrimaryData(oauth, env) {
		this.projectData = { primary: { name: 'current', env, oauth }, others: [] };
		this._write();
	}

	_write() {
		fs.writeFile(this.projectFilePath, JSON.stringify(this.projectData), err => {
			if (err) this.emit('projectError', JSON.stringify(err));
			this.emit('projectLoaded', 'Successfully saved Force.com project data.');
		});
	}

	_getPackage(reload) {
		if (this.package && !reload) {
			return Promise.resolve(this.package);
		}

		return new Promise((resolve, reject) => {
			fs.readFile(this.projRoot + '/src/package.xml', (err, data) => {
				if (err) {
					reject(err);
				} else {
					new xml2js.Parser().parseString(data, (err, result) => {
						if (err) {
							reject(err);
						} else {
							resolve(result);
						}
					});
				}
			});
		});
	}

	emit(type, ...args) {
		super.emit(type, ...args);
		console.log(`SfConnection emitted ${type} with args ${JSON.stringify(args)}`);
	}
}
