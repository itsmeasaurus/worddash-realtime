import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultWordsPath = path.resolve(repoRoot, "..", "words.txt");

function normalizeSpaces(value) {
  return value.replace(/\s+/g, " ").trim();
}

function parseArgs(argv) {
  const options = {
    file: defaultWordsPath
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--file" && argv[i + 1]) {
      options.file = path.resolve(process.cwd(), argv[i + 1]);
      i += 1;
    }
  }

  return options;
}

function parseWordsText(content) {
  const lines = content.split(/\r?\n/);
  const records = [];
  const errors = [];
  let pendingWord = null;
  let pendingWordLine = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const trimmed = lines[index].trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.startsWith("Word-")) {
      if (pendingWord !== null) {
        errors.push(
          `Line ${pendingWordLine}: missing Hint- for previous word "${pendingWord}"`
        );
      }

      pendingWord = normalizeSpaces(trimmed.slice("Word-".length));
      pendingWordLine = lineNo;

      if (!pendingWord) {
        errors.push(`Line ${lineNo}: Word- value is empty`);
        pendingWord = null;
      }

      continue;
    }

    if (trimmed.startsWith("Hint-")) {
      if (pendingWord === null) {
        errors.push(`Line ${lineNo}: Hint- appears before Word-`);
        continue;
      }

      const rawHint = normalizeSpaces(trimmed.slice("Hint-".length));
      if (!rawHint) {
        errors.push(`Line ${lineNo}: Hint- value is empty for word "${pendingWord}"`);
        pendingWord = null;
        pendingWordLine = 0;
        continue;
      }

      const normalizedWord = normalizeSpaces(pendingWord).toLowerCase();
      records.push({
        word: normalizedWord,
        hint: rawHint,
        length: normalizedWord.length
      });

      pendingWord = null;
      pendingWordLine = 0;
      continue;
    }

    errors.push(`Line ${lineNo}: unsupported format "${trimmed}"`);
  }

  if (pendingWord !== null) {
    errors.push(`Line ${pendingWordLine}: missing Hint- for word "${pendingWord}"`);
  }

  return { records, errors };
}

function mergeDuplicates(records) {
  const merged = new Map();
  let duplicateCount = 0;

  for (const record of records) {
    if (merged.has(record.word)) {
      duplicateCount += 1;
    }
    merged.set(record.word, record);
  }

  return {
    uniqueRecords: [...merged.values()],
    duplicateCount
  };
}

async function main() {
  const { file } = parseArgs(process.argv.slice(2));
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseSecretKey =
    process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseSecretKey) {
    throw new Error(
      "Missing SUPABASE_URL or SUPABASE_SECRET_KEY in environment."
    );
  }

  const wordsText = await fs.readFile(file, "utf8");
  const parsed = parseWordsText(wordsText);

  if (parsed.errors.length > 0) {
    console.error("Import aborted due to input format errors:");
    for (const message of parsed.errors.slice(0, 20)) {
      console.error(`- ${message}`);
    }
    if (parsed.errors.length > 20) {
      console.error(`- ... and ${parsed.errors.length - 20} more errors`);
    }
    process.exit(1);
  }

  const { uniqueRecords, duplicateCount } = mergeDuplicates(parsed.records);
  const words = uniqueRecords.map((item) => item.word);

  const supabase = createClient(supabaseUrl, supabaseSecretKey);
  const db = supabase.schema("worddash");

  const { data: existingRows, error: existingError } = await db
    .from("words")
    .select("word,hint,length")
    .in("word", words);

  if (existingError) {
    throw new Error(`Failed reading existing rows: ${existingError.message}`);
  }

  const existingMap = new Map(existingRows.map((row) => [row.word, row]));
  const toUpsert = [];
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const record of uniqueRecords) {
    const current = existingMap.get(record.word);
    if (!current) {
      toUpsert.push(record);
      inserted += 1;
      continue;
    }

    if (current.hint === record.hint && current.length === record.length) {
      skipped += 1;
      continue;
    }

    toUpsert.push(record);
    updated += 1;
  }

  if (toUpsert.length > 0) {
    const { error: upsertError } = await db.from("words").upsert(toUpsert, {
      onConflict: "word",
      ignoreDuplicates: false
    });
    if (upsertError) {
      throw new Error(`Upsert failed: ${upsertError.message}`);
    }
  }

  const failed = 0;
  console.log("Word import report");
  console.log(`- source_file: ${file}`);
  console.log(`- parsed_records: ${parsed.records.length}`);
  console.log(`- duplicate_records_in_file: ${duplicateCount}`);
  console.log(`- unique_records: ${uniqueRecords.length}`);
  console.log(`- inserted: ${inserted}`);
  console.log(`- updated: ${updated}`);
  console.log(`- skipped: ${skipped}`);
  console.log(`- failed: ${failed}`);
}

main().catch((error) => {
  console.error(`Word import failed: ${error.message}`);
  process.exit(1);
});
