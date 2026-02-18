package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/cschnabel/mtgdata/internal/api"
	"github.com/cschnabel/mtgdata/internal/db"
	"github.com/cschnabel/mtgdata/internal/ingest"
)

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)

	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	cmd := os.Args[1]
	switch cmd {
	case "parse":
		if err := runParse(ctx, os.Args[2:]); err != nil {
			log.Fatalf("parse failed: %v", err)
		}
	case "tail":
		if err := runTail(ctx, os.Args[2:]); err != nil {
			log.Fatalf("tail failed: %v", err)
		}
	case "serve":
		if err := runServe(ctx, os.Args[2:]); err != nil {
			log.Fatalf("serve failed: %v", err)
		}
	default:
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println("mtgdata commands:")
	fmt.Println("  parse -db <path> -log <path> [-resume=true]")
	fmt.Println("  tail  -db <path> -log <path> [-interval=2s]")
	fmt.Println("  serve -db <path> [-addr=:8080] [-web-dist=<path>]")
}

func runParse(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("parse", flag.ContinueOnError)
	dbPath := fs.String("db", "data/mtgdata.db", "sqlite database path")
	logPath := fs.String("log", "data/Player-prev.log", "arena log path")
	resume := fs.Bool("resume", true, "resume from previous offset")
	if err := fs.Parse(args); err != nil {
		return err
	}

	database, err := db.Open(*dbPath)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		return err
	}

	parser := ingest.NewParser(db.NewStore(database))
	stats, err := parser.ParseFile(ctx, *logPath, *resume)
	if err != nil {
		return err
	}

	duration := stats.CompletedAt.Sub(stats.StartedAt)
	log.Printf("parse complete: lines=%d bytes=%d raw_events=%d matches=%d decks=%d draft_picks=%d duration=%s",
		stats.LinesRead,
		stats.BytesRead,
		stats.RawEventsStored,
		stats.MatchesUpserted,
		stats.DecksUpserted,
		stats.DraftPicksAdded,
		duration,
	)

	return nil
}

func runTail(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("tail", flag.ContinueOnError)
	dbPath := fs.String("db", "data/mtgdata.db", "sqlite database path")
	logPath := fs.String("log", "data/Player-prev.log", "arena log path")
	interval := fs.Duration("interval", 2*time.Second, "poll interval")
	if err := fs.Parse(args); err != nil {
		return err
	}

	database, err := db.Open(*dbPath)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		return err
	}

	parser := ingest.NewParser(db.NewStore(database))
	log.Printf("tailing %s every %s", *logPath, interval.String())

	ticker := time.NewTicker(*interval)
	defer ticker.Stop()

	for {
		if _, err := parser.ParseFile(ctx, *logPath, true); err != nil {
			log.Printf("tail parse error: %v", err)
		}

		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func runServe(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	dbPath := fs.String("db", "data/mtgdata.db", "sqlite database path")
	addr := fs.String("addr", ":8080", "http listen address")
	webDist := fs.String("web-dist", "", "path to built frontend dist")
	if err := fs.Parse(args); err != nil {
		return err
	}

	database, err := db.Open(*dbPath)
	if err != nil {
		return err
	}
	defer database.Close()

	if err := db.Init(ctx, database); err != nil {
		return err
	}

	staticDir := *webDist
	if staticDir == "" {
		cwd, err := os.Getwd()
		if err == nil {
			staticDir = api.DefaultStaticDir(cwd)
		}
	}
	if staticDir != "" {
		staticDir, _ = filepath.Abs(staticDir)
	}

	server := api.NewServer(db.NewStore(database), staticDir)
	return server.Run(ctx, *addr)
}
