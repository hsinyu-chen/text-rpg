import { Component, ElementRef, inject, afterNextRender, DestroyRef, viewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MonacoLoaderService } from '../../core/services/monaco-loader.service';
import { IdleService } from '../../core/services/idle.service';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import * as monaco from 'monaco-editor';

const CODE_SNIPPETS = [
  {
    lang: 'typescript',
    content: `import { Injectable, inject, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { catchError, map, shareReplay, switchMap, tap } from 'rxjs/operators';
import { Observable, throwError, BehaviorSubject, combineLatest } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class EnterpriseDataService {
  private http = inject(HttpClient);
  private cache$ = new Map<string, Observable<any>>();

  readonly apiEndpoint = '/api/v1/internal/analytics/aggregate';
  
  private refreshTrigger = new BehaviorSubject<void>(undefined);
  
  dataState = signal<{ loading: boolean, error: string | null, data: any[] }>({
    loading: false,
    error: null,
    data: []
  });

  processDataStream(id: string, options: QueryOptions) {
    return this.refreshTrigger.pipe(
      switchMap(() => this.fetchRemoteBuffer(id, options)),
      map(buffer => this.normalizeSchema(buffer)),
      tap(data => this.updateLocalSignals(data)),
      catchError(err => this.handleProtocolError(err))
    );
  }

  private async fetchRemoteBuffer(id: string, options: any) {
    const payload = this.serializePredicate(options);
    return this.http.post(\`\${this.apiEndpoint}/\${id}\`, payload).toPromise();
  }

  private normalizeSchema(raw: any) {
    // Perform complex recursive schema mapping
    return Object.keys(raw).reduce((acc, key) => {
      acc[this.hashKey(key)] = typeof raw[key] === 'object' 
        ? this.normalizeSchema(raw[key]) 
        : raw[key];
      return acc;
    }, {} as any);
  }

  private hashKey(key: string): string {
    return btoa(key).replace(/=/g, '').substring(0, 8);
  }
}`
  },
  {
    lang: 'python',
    content: `import torch
import torch.nn as nn
import torch.optim as optim
from torch.utils.data import DataLoader, Dataset

class MultiHeadAttentionTransformer(nn.Module):
    def __init__(self, embed_size, heads):
        super(MultiHeadAttentionTransformer, self).__init__()
        self.embed_size = embed_size
        self.heads = heads
        self.head_dim = embed_size // heads

        assert (
            self.head_dim * heads == embed_size
        ), "Embedding size needs to be divisible by heads"

        self.values = nn.Linear(self.head_dim, self.head_dim, bias=False)
        self.keys = nn.Linear(self.head_dim, self.head_dim, bias=False)
        self.queries = nn.Linear(self.head_dim, self.head_dim, bias=False)
        self.fc_out = nn.Linear(heads * self.head_dim, embed_size)

    def forward(self, values, keys, query, mask):
        N = query.shape[0]
        value_len, key_len, query_len = values.shape[1], keys.shape[1], query.shape[1]

        # Split the embedding into self.heads different pieces
        values = values.reshape(N, value_len, self.heads, self.head_dim)
        keys = keys.reshape(N, key_len, self.heads, self.head_dim)
        query = query.reshape(N, query_len, self.heads, self.head_dim)

        values = self.values(values)
        keys = self.keys(keys)
        queries = self.queries(query)

        # Einsum does matrix multiplication for query*keys for each training example
        energy = torch.einsum("nqhd,nkhd->nhqk", [queries, keys])

        if mask is not None:
            energy = energy.masked_fill(mask == 0, float("-1e20"))

        attention = torch.softmax(energy / (self.embed_size ** (1 / 2)), dim=3)

        out = torch.einsum("nhql,nlhd->nqhd", [attention, values]).reshape(
            N, query_len, self.heads * self.head_dim
        )

        out = self.fc_out(out)
        return out`
  },
  {
    lang: 'rust',
    content: `use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

#[derive(Debug)]
struct TransactionManager {
    balance: Mutex<f64>,
    log: Arc<Mutex<Vec<String>>>,
}

impl TransactionManager {
    fn new(initial_balance: f64) -> Self {
        TransactionManager {
            balance: Mutex::new(initial_balance),
            log: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn execute_transfer(&self, amount: f64, destination: &str) -> Result<(), String> {
        let mut balance = self.balance.lock().map_err(|e| e.to_string())?;
        
        if *balance < amount {
            return Err("Insufficient funds for atomic operation".to_string());
        }

        thread::sleep(Duration::from_millis(50));
        *balance -= amount;
        
        let log_entry = format!("Transfer of {} to {} executed at current sequence", amount, destination);
        let mut log = self.log.lock().map_err(|e| e.to_string())?;
        log.push(log_entry);

        Ok(())
    }
}

fn main() {
    let manager = Arc::new(TransactionManager::new(10000.0));
    let mut handles = vec![];

    for i in 0..10 {
        let mgr = Arc::clone(&manager);
        let handle = thread::spawn(move || {
            match mgr.execute_transfer(100.0 * (i as f64), "B-Node-42") {
                Ok(_) => println!("Thread {} successful", i),
                Err(e) => eprintln!("Thread {} failed: {}", i, e),
            }
        });
        handles.push(handle);
    }

    for handle in handles {
        handle.join().unwrap();
    }
    
    println!("Final State: {:?}", manager);
}`
  }
];

@Component({
  selector: 'app-code-screensaver',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatIconModule],
  template: `
    <div class="screensaver-container">
      <div #monacoContainer class="monaco-container"></div>
      <button mat-icon-button class="exit-btn" (click)="exit()" aria-label="Exit Boss Key">
        <mat-icon>close</mat-icon>
      </button>
      <div class="overlay"></div>
    </div>
  `,
  styles: [`
    .screensaver-container {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: #1e1e1e;
      z-index: 9999;
      cursor: text;
    }
    .monaco-container {
      width: 100%;
      height: 100%;
    }
    .exit-btn {
      position: absolute;
      top: 20px;
      right: 20px;
      color: rgba(255, 255, 255, 0.3);
      z-index: 10001;
      transition: color 0.3s, background-color 0.3s;
    }
    .exit-btn:hover {
      color: white;
      background-color: rgba(255, 255, 255, 0.1);
    }
    .overlay {
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 10000;
        pointer-events: none;
        box-shadow: inset 0 0 100px rgba(0,0,0,0.5);
    }
  `]
})
export class CodeScreensaverComponent {
  private monacoContainer = viewChild.required<ElementRef>('monacoContainer');

  private monacoLoader = inject(MonacoLoaderService);
  private idleService = inject(IdleService);
  private destroyRef = inject(DestroyRef);
  private editor!: monaco.editor.IStandaloneCodeEditor;

  constructor() {
    afterNextRender(async () => {
      const monacoInst = await this.monacoLoader.load();
      const snippet = CODE_SNIPPETS[Math.floor(Math.random() * CODE_SNIPPETS.length)];

      this.editor = monacoInst.editor.create(this.monacoContainer().nativeElement, {
        value: snippet.content,
        language: snippet.lang,
        theme: 'vs-dark',
        automaticLayout: true,
        readOnly: true,
        minimap: { enabled: true },
        fontSize: 14,
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        renderWhitespace: 'none',
        cursorStyle: 'line',
        fontFamily: "'Fira Code', 'Consolas', 'Courier New', monospace"
      });
    });

    this.destroyRef.onDestroy(() => {
      if (this.editor) {
        this.editor.dispose();
      }
    });
  }

  exit() {
    this.idleService.closeScreensaver();
  }
}
