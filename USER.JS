
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

// Initialize Firebase using your service account
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
});

async function deleteAllUsers() {
  let nextPageToken;
  let totalDeleted = 0;
  let totalFailed = 0;

  try {
    console.log("Connected Firebase project:", serviceAccount.project_id);

    // First collect all user IDs, before deleting anything
    const allUIDs = [];

    do {
      const result = await admin.auth().listUsers(1000, nextPageToken);

      for (const user of result.users) {
        allUIDs.push(user.uid);
      }

      nextPageToken = result.pageToken;
    } while (nextPageToken);

    console.log("Total users found:", allUIDs.length);

    if (allUIDs.length === 0) {
      console.log("No users found.");
      return;
    }

    // Delete users in batches of up to 1000
    for (let i = 0; i < allUIDs.length; i += 1000) {
      const batch = allUIDs.slice(i, i + 1000);
      const result = await admin.auth().deleteUsers(batch);

      totalDeleted += result.successCount;
      totalFailed += result.failureCount;

      console.log(
        `Processed ${Math.min(i + batch.length, allUIDs.length)} / ${allUIDs.length}`
      );

      if (result.failureCount > 0) {
        console.log("Failed UIDs in this batch:");

        for (const error of result.errors) {
          console.log({
            index: error.index,
            uid: batch[error.index],
            error: error.error.message,
          });
        }
      }
    }

    console.log("\nDeletion finished.");
    console.log("Successfully deleted:", totalDeleted);
    console.log("Failed:", totalFailed);
  } catch (error) {
    console.error("Firebase error:", error);
  }
}

deleteAllUsers();
