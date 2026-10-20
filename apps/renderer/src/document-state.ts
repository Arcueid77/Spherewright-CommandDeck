export class DocumentLease {
	private revision = 0;
	private request = 0;
	changed() { this.revision++; }
	async load<T>(read: () => Promise<T>, commit: (value: T) => void) {
		const revision = this.revision, request = ++this.request;
		const value = await read();
		if (revision !== this.revision || request !== this.request) return false;
		commit(value);
		return true;
	}
}
