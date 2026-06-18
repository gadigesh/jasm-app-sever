const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = process.cwd();
const UPLOAD_DIR = path.join(PROJECT_ROOT, "uploads");
const MAX_STORAGE_BYTES = 100 * 1024 * 1024; // 100 MB Limit

// Ensure folder exists
if (!fs.existsSync(UPLOAD_DIR)) {
	fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

/**
 * 🧹 Disk Rotation Logic
 * Checks total size of uploads folder. If > 100MB, delete oldest files.
 */
async function enforceDiskLimit() {
	try {
		const files = await fs.promises.readdir(UPLOAD_DIR);

		// 1. Get stats for all files (Size and Created Time)
		const fileStats = await Promise.all(
			files.map(async (file) => {
				const filePath = path.join(UPLOAD_DIR, file);
				const stats = await fs.promises.stat(filePath);
				return {
					name: file,
					path: filePath,
					size: stats.size,
					time: stats.birthtimeMs, // Creation time
				};
			})
		);

		// 2. Calculate Total Size
		let totalSize = fileStats.reduce((acc, file) => acc + file.size, 0);

		// If we are safe, stop here.
		if (totalSize <= MAX_STORAGE_BYTES) return;

		console.log(
			`[Storage] Limit Exceeded (${(totalSize / 1024 / 1024).toFixed(
				2
			)}MB). Cleaning up...`
		);

		// 3. Sort by Oldest First
		fileStats.sort((a, b) => a.time - b.time);

		// 4. Delete files until we are under the limit
		for (const file of fileStats) {
			if (totalSize <= MAX_STORAGE_BYTES) break; // We are safe now

			console.log(`[Storage] Deleting old file: ${file.name}`);
			await fs.promises.unlink(file.path);

			totalSize -= file.size; // Subtract size from total
		}

		console.log(
			`[Storage] Cleanup Complete. Current Size: ${(
				totalSize /
				1024 /
				1024
			).toFixed(2)}MB`
		);
	} catch (error) {
		console.error("[Storage] Error enforcing disk limit:", error);
	}
}

module.exports = {
	async saveFile(fileObject) {
		// 1. Prepare Paths
		const cleanName = fileObject.originalname.replace(/\s+/g, "_");
		const uniqueFileName = `${Date.now()}_${cleanName}`;
		const targetPath = path.join(UPLOAD_DIR, uniqueFileName);

		try {
			// 2. Save the new file
			await fs.promises.copyFile(fileObject.path, targetPath);
			await fs.promises.unlink(fileObject.path); // Remove temp

			// 3. 🧹 CHECK DISK SPACE LIMIT AFTER SAVING
			await enforceDiskLimit();

			return targetPath;
		} catch (error) {
			console.error("[Storage] Error moving file:", error);
			throw new Error("Failed to store file locally");
		}
	},

	async deleteFile(pathRef) {
		// We keep this function available, but we won't call it automatically anymore
		if (fs.existsSync(pathRef)) {
			await fs.promises.unlink(pathRef);
		}
	},

	getReadStream(pathRef) {
		if (!fs.existsSync(pathRef))
			throw new Error(`File not found: ${pathRef}`);
		return fs.createReadStream(pathRef);
	},
};
