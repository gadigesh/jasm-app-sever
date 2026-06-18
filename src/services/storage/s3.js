module.exports = {
	async saveFile(fileObject) {
		throw new Error("S3 Storage not yet configured. Please use LOCAL.");
		// FUTURE CODE:
		// const s3 = new S3Client({...});
		// await s3.send(new PutObjectCommand({...}));
		// return objectKey;
	},

	async deleteFile(pathRef) {
		console.log("S3 delete not implemented yet");
	},

	getReadStream(pathRef) {
		// FUTURE CODE:
		// return s3Stream;
	},
};
