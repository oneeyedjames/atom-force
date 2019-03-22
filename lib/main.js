'use babel';

import { CompositeDisposable } from 'atom';
import AtomForce from './atom-force.js';

const atomForce = new AtomForce();

export default {
	activate() {
		atomForce.init();
		this.subscriptions = new CompositeDisposable();
	},
	deactivate() {
		console.log('atom-force deactivate()');
		this.subscriptions.dispose();
	},
	consumeLinter(indieRegistry) {
		const afLinter = indieRegistry.register({ name: 'atom-force' });
		this.subscriptions.add(afLinter);
		atomForce.linter = afLinter;
	},
	consumeSignal(registry) {
		const provider = registry.create();
		this.subscriptions.add(provider);
		atomForce.busySignal = provider;
	},
};
