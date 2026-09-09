'use client';
import { useEffect, useState } from 'react';
import { Layers3, FlaskConical, Sun, Moon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useLocalWorkspace } from '@/lib/local-workspace';
import { PositionsPanel, SettingsPanel } from './practice-panels';
import { CreationDialog } from './creation-dialog';
import { ActivityPanel } from './activity-panel';

export default function Workbench() {
  const [tab, setTab] = useState('positions');
  const [creating, setCreating] = useState(false);
  const { book, notice, dark, loaded, saveBook, setDark } = useLocalWorkspace();
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
  }, [dark]);
  return (
    <>
      <Tabs className="dm-app" value={tab} onValueChange={setTab}>
        <header className="dm-header">
          <button
            className="dm-brand"
            onClick={() => setTab('positions')}
            aria-label="Domino home"
          >
            <Layers3 size={28} aria-hidden="true" />
            <span>
              domino<span className="dm-brand-dot">.</span>
            </span>
          </button>
          <span className="dm-network">Robinhood Chain</span>
          <span className="dm-practice">
            <FlaskConical size={15} aria-hidden="true" /> Practice mode
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={dark ? 'Use light appearance' : 'Use dark appearance'}
            onClick={() => setDark(!dark)}
          >
            {dark ? <Sun /> : <Moon />}
          </Button>
        </header>
        <div className="dm-nav">
          <TabsList variant="line" aria-label="Workspace">
            <TabsTrigger value="positions">
              My positions{' '}
              <span className="dm-count">{book.positions.length}</span>
            </TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <span className="dm-nav-note">
            A little practice. A clearer picture.
          </span>
        </div>
        {notice && <output className="dm-notice">{notice}</output>}
        <main className="dm-main">
          {!loaded ? (
            <output className="dm-muted">
              Opening your workspace…
            </output>
          ) : (
            <>
              <TabsContent value="positions">
                <PositionsPanel
                  book={book}
                  setBook={saveBook}
                  onCreate={() => setCreating(true)}
                  onActivity={() => setTab('activity')}
                />
              </TabsContent>
              <TabsContent value="activity">
                <ActivityPanel book={book} />
              </TabsContent>
              <TabsContent value="settings">
                <SettingsPanel dark={dark} onDark={setDark} />
              </TabsContent>
            </>
          )}
          <footer className="dm-workspace-footer">
            <FlaskConical size={15} aria-hidden="true" /> A practice space.
            Simulated assets, saved on this browser. No wallet transactions.
          </footer>
        </main>
      </Tabs>
      <CreationDialog
        open={creating}
        onOpenChange={setCreating}
        setBook={saveBook}
        onCreated={() => setTab('positions')}
      />
    </>
  );
}
