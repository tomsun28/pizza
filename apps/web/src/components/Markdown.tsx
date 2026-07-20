import { memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Copy, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

function CodeBlock({ code, lang }: { code: string; lang?: string }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const copy = () => {
		void navigator.clipboard.writeText(code);
		setCopied(true);
		setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="group/code relative my-3 overflow-hidden rounded-lg border border-border bg-surface-2">
			<div className="flex items-center justify-between border-b border-border/60 px-3 py-1.5">
				<span className="font-mono text-[10px] uppercase tracking-widest text-muted">
					{lang || t("markdown.code")}
				</span>
				<button
					type="button"
					onClick={copy}
					className="flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] text-muted transition-colors hover:bg-surface hover:text-fg"
					title={t("markdown.copyCode")}
				>
					{copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
					{copied ? t("markdown.copied") : t("markdown.copy")}
				</button>
			</div>
			<pre className="overflow-x-auto px-3 py-2.5">
				<code className="font-mono text-xs leading-relaxed text-fg">{code}</code>
			</pre>
		</div>
	);
}

function MarkdownImpl({ children, className }: { children: string; className?: string }) {
	return (
		<div className={cn("md", className)}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					pre: ({ children }) => <>{children}</>,
					code: ({ className: cls, children: c }) => {
						const raw = String(c ?? "");
						const match = /language-(\w+)/.exec(cls || "");
						const isBlock = !!match || raw.includes("\n");
						if (!isBlock) {
							return (
								<code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[0.85em] text-fg">
									{c as ReactNode}
								</code>
							);
						}
						return <CodeBlock code={raw.replace(/\n$/, "")} lang={match?.[1]} />;
					},
					a: ({ children: c, href }) => (
						<a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2 hover:opacity-80">
							{c as ReactNode}
						</a>
					),
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}

export const Markdown = memo(MarkdownImpl);
