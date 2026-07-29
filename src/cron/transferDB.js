import { MongoClient } from "mongodb";
import dns from "node:dns";

// Windows DNS fix for Atlas SRV lookup
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// Target: Self-hosted MongoDB (Remove retryWrites & w=majority for standalone servers)
const TARGET_URI =
  "mongodb://suvidha_stuuser:3453sGSoG3XYv9b2Z6ZG@164.52.193.152:27017/suvidha_studb?authSource=suvidha_studb";

// Source: MongoDB Atlas (Requires tls: true and retryWrites=true&w=majority)
const SOURCE_URI =
  "mongodb+srv://tushar_db_user:uNYhrg7tZ8S9gmdt@cluster0.k3ylgca.mongodb.net/suvidha_stu?retryWrites=true&w=majority";
// mongodb://suvidha_stuuser:3453sGSoG3XYv9b2Z6ZG@164.52.193.152/?authSource=suvidha_studb
async function transferExactDatabase() {
  // Source Client: Atlas (TLS REQUIRED)
  const sourceClient = new MongoClient(SOURCE_URI, {
    tls: true,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });

  // Target Client: VPS Standalone Server (NO TLS)
  const targetClient = new MongoClient(TARGET_URI, {
    tls: false,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });

  try {
    console.log("Connecting to both clusters...");
    await sourceClient.connect();
    await targetClient.connect();
    console.log("✅ Connected successfully!\n");

    const srcDb = sourceClient.db("suvidha_stu");
    const targetDb = targetClient.db("suvidha_studb");

    const collections = await srcDb.listCollections().toArray();

    if (collections.length === 0) {
      console.log("❌ No collections found in source database 'new_dothis2'.");
      return;
    }

    for (const collInfo of collections) {
      const collName = collInfo.name;
      if (collName.startsWith("system.")) continue;

      console.log(`Copying collection: ${collName}...`);

      const docs = await srcDb.collection(collName).find({}).toArray();

      if (docs.length > 0) {
        // Clear target collection to prevent duplicate _id conflicts
        await targetDb.collection(collName).deleteMany({});

        // Insert documents into target DB
        await targetDb.collection(collName).insertMany(docs);
        console.log(`  ✅ Done: "${collName}" (${docs.length} documents copied)`);
      } else {
        console.log(`  ⚠️ "${collName}" is empty. Skipped.`);
      }
    }

    console.log(
      "\n🎉 Database 'new_dothis2' data copied to target server successfully!"
    );
  } catch (err) {
    console.error("Transfer failed:", err);
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

transferExactDatabase();