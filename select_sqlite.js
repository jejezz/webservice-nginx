const sqlite3 = require('sqlite3');

function printDatabaseTables(dbPath) {
  const sqliteDB = sqlite3.verbose().Database;
  const db = new sqliteDB(dbPath, (err) => {
    if (err) {
      console.error('Failed to connect to the database:', err.message);
      return;
    }
    console.log('Connected to the SQLite database:', dbPath);
    
    db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, tables) => {
      if (err) {
        console.error('Failed to retrieve table list:', err.message);
        db.close();
        return;
      }

      if (tables.length === 0) {
        console.log('No tables found in the database.');
        db.close();
        return;
      }

      console.log('\n--- Tables in the Database ---');
      tables.forEach(tableInfo => {
        const tableName = tableInfo.name;
        console.log(`\n--- Table: ${tableName} ---`);
        printTableContent(db, tableName);
      });

      db.close(() => {
        console.log('\nDatabase connection closed.');
      });
    });
  });
}

function printTableContent(db, tableName) {
  db.all(`SELECT * FROM ${tableName}`, [], (err, rows) => {
    if (err) {
      console.error(`Failed to retrieve data from table "${tableName}":`, err.message);
      return;
    }

    if (rows.length === 0) {
      console.log(`Table "${tableName}" is empty.`);
      return;
    }

    // Get column names from the first row (if any)
    const columns = Object.keys(rows[0] || {});
    if (columns.length === 0) {
      console.log(`Table "${tableName}" has no columns.`);
      return;
    }

    // Print header
    const header = columns.map(col => pad(col, 20)).join(' | ');
    console.log(header);
    console.log('-'.repeat(header.length));

    // Print rows
    rows.forEach(row => {
      const rowData = columns.map(col => pad(row[col] !== undefined && row[col] !== null ? row[col].toString() : '', 20)).join(' | ');
      console.log(rowData);
    });
  });
}

function pad(str, length) {
  const padded = (str || '').toString().padEnd(length);
  return padded.substring(0, length);
}

// --- Usage ---
const databasePath = 'cf2rtc-sqlite-db.db'; // Replace with the actual path to your SQLite database file
printDatabaseTables(databasePath);