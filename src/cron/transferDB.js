import { MongoClient } from "mongodb";
import dns from "node:dns";

// Windows DNS fix
dns.setServers(["8.8.8.8", "1.1.1.1"]);

// 1st Screenshot (Cluster 1 / k3ylgca) - Source: suvidha_stu
const TARGET_URI =
  "mongodb+srv://tushar_db_user:uNYhrg7tZ8S9gmdt@cluster0.k3ylgca.mongodb.net/suvidha_stu?retryWrites=true&w=majority";

// 2nd Screenshot (Cluster 2 / bwwjwiy) - Target: suvidha_stu
const SOURCE_URI =
  "mongodb+srv://dothis2_db_user:GDRY6c2wkvKClj7I@cluster0.bwwjwiy.mongodb.net/suvidha_stu?retryWrites=true&w=majority";

async function transferExactDatabase() {
  const sourceClient = new MongoClient(SOURCE_URI, {
    tls: true,
    tlsAllowInvalidCertificates: true,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });

  const targetClient = new MongoClient(TARGET_URI, {
    tls: true,
    tlsAllowInvalidCertificates: true,
    connectTimeoutMS: 30000,
    socketTimeoutMS: 30000,
  });

  try {
    console.log("Connecting to both clusters...");
    await sourceClient.connect();
    await targetClient.connect();
    console.log("✅ Connected successfully!\n");

    const srcDb = sourceClient.db("suvidha_stu");
    const targetDb = targetClient.db("suvidha_stu");

    const collections = await srcDb.listCollections().toArray();

    if (collections.length === 0) {
      console.log("❌ No collections found in source database 'suvidha_stu'.");
      return;
    }

    for (const collInfo of collections) {
      const collName = collInfo.name;
      if (collName.startsWith("system.")) continue;

      console.log(`Copying collection: ${collName}...`);

      const docs = await srcDb.collection(collName).find({}).toArray();

      if (docs.length > 0) {
        // Target collection clear karo taaki duplicate primary key error na aaye
        await targetDb.collection(collName).deleteMany({});
        
        // Target cluster me records insert karo
        await targetDb.collection(collName).insertMany(docs);
        console.log(`  ✅ Done: "${collName}" (${docs.length} documents copied)`);
      } else {
        console.log(`  ⚠️ "${collName}" is empty. Skipped.`);
      }
    }

    console.log("\n🎉 Database 'suvidha_stu' ka sara data target cluster me successfully copy ho gaya!");
  } catch (err) {
    console.error("Transfer failed:", err);
  } finally {
    await sourceClient.close();
    await targetClient.close();
  }
}

transferExactDatabase();