import { Modal } from './Modal';
import { useT, type TranslationKey } from '../i18n';

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  titleKey: TranslationKey;
  shortcuts: Array<{ keys: string[]; labelKey: TranslationKey }>;
}

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    titleKey: 'help.group.projectWindows',
    shortcuts: [
      { keys: ['Ctrl', 'B'], labelKey: 'help.kb.sidebar' },
      { keys: ['Esc'],       labelKey: 'help.kb.closeDialog' },
      { keys: ['Ctrl', 'K'], labelKey: 'help.kb.searchColumns' },
    ],
  },
];

export function HelpModal({ open, onClose }: Props) {
  const t = useT();
  return (
    <Modal open={open} onClose={onClose} title={t('menu.help')} width={460}>
      <Section title={t('help.shortcuts')}>
        {SHORTCUT_GROUPS.map((g) => (
          <div key={g.titleKey} style={styles.group}>
            <div style={styles.groupTitle}>[{t(g.titleKey)}]</div>
            <table style={styles.kbTable}>
              <tbody>
                {g.shortcuts.map((s, i) => (
                  <tr key={i}>
                    <td style={styles.kbKeys}>
                      {s.keys.map((k, j) => (
                        <span key={j}>
                          <kbd style={styles.kbd}>{k}</kbd>
                          {j < s.keys.length - 1 && <span style={styles.kbSep}>+</span>}
                        </span>
                      ))}
                    </td>
                    <td style={styles.kbLabel}>{t(s.labelKey)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </Section>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={styles.sectionTitle}>{title}</div>
      {children}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  sectionTitle: {
    fontSize: 10.5,
    color: 'var(--text-3)',
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    fontWeight: 600,
    marginBottom: 8,
  },
  group: { marginBottom: 10 },
  groupTitle: {
    fontSize: 11,
    color: 'var(--navy)',
    fontWeight: 600,
    fontFamily: 'var(--mono)',
    marginBottom: 4,
  },
  kbTable: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 12,
  },
  kbKeys: {
    padding: '4px 0',
    width: 140,
    whiteSpace: 'nowrap',
  },
  kbSep: { padding: '0 4px', color: 'var(--text-4)', fontSize: 10 },
  kbd: {
    display: 'inline-block',
    padding: '1px 6px',
    fontFamily: 'var(--mono)',
    fontSize: 10.5,
    background: 'var(--panel-2)',
    border: '1px solid var(--border-strong)',
    borderRadius: 3,
    color: 'var(--text-2)',
  },
  kbLabel: {
    padding: '4px 0',
    color: 'var(--text-2)',
  },
  tipsList: {
    margin: 0,
    paddingLeft: 18,
    fontSize: 12,
    color: 'var(--text-2)',
  },
  tipsItem: { lineHeight: 1.7 },
};
