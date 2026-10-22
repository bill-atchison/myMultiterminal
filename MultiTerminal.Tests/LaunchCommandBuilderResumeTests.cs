using System;
using System.IO;
using MultiTerminal.Models;
using MultiTerminal.Services;
using MultiTerminal.Terminal;
using Xunit;

namespace MultiTerminal.Tests
{
    /// <summary>
    /// Pins the resume-session contract of <see cref="LaunchCommandBuilder"/> (task ec2ed636): an
    /// optional session id becomes <c>--resume &lt;id&gt;</c> on the Claude command line.
    ///
    /// <para>WHAT IS ASSERTED, AND HOW. The flag contents around it (plugin path, statusline merge)
    /// depend on the machine, so the resume facts compare a with-id build against a no-id build for
    /// the SAME cwd rather than against a literal: the only permitted difference is the inserted
    /// <c> --resume &lt;id&gt;</c>, directly before <c> --dangerously-skip-permissions</c>.</para>
    ///
    /// <para>ID FORMAT DECISION. Parsing is <c>Guid.TryParseExact(…, "D")</c>: uppercase hex is
    /// ACCEPTED and emitted lowercase; braced, hyphenless and anything-else forms are REJECTED with
    /// <see cref="ArgumentException"/>. The id is spliced unquoted into a PowerShell line, so only the
    /// re-formatted GUID (hex and hyphens) may ever reach it.</para>
    ///
    /// <para>The Codex fact pins only THAT a Codex launch with an id throws. It does NOT pin that the
    /// refusal runs before <c>BuildCodexCommand</c>'s side effects (config.toml, broker probe): moving
    /// the check after the call would still throw and stay green, while writing to the developer's
    /// machine on every run. That ordering is review-only; there is no seam to observe it.</para>
    /// </summary>
    public class LaunchCommandBuilderResumeTests
    {
        private const string Id = "0f8fad5b-d9cb-469f-a165-70867728950e";
        private const string Skip = " --dangerously-skip-permissions";

        [Fact]
        public void No_id_emits_no_resume_and_matches_the_default_overload()
        {
            WithTempDir(dir =>
            {
                string before = LaunchCommandBuilder.BuildClaudeCommand(null, dir).AutoRunCommand;
                string withNull = LaunchCommandBuilder.BuildClaudeCommand(null, dir, null).AutoRunCommand;
                string withBlank = LaunchCommandBuilder.BuildClaudeCommand(null, dir, "   ").AutoRunCommand;

                Assert.DoesNotContain("--resume", before);
                Assert.Equal(before, withNull);
                Assert.Equal(before, withBlank);
            });
        }

        [Fact]
        public void Valid_id_is_inserted_once_directly_before_skip_permissions()
        {
            WithTempDir(dir =>
            {
                string fresh = LaunchCommandBuilder.BuildClaudeCommand(null, dir).AutoRunCommand;
                string resumed = LaunchCommandBuilder.BuildClaudeCommand(null, dir, Id).AutoRunCommand;

                // The whole difference is the inserted flag, at that position.
                Assert.Equal(fresh.Replace(Skip, $" --resume {Id}{Skip}"), resumed);
                Assert.Equal(1, CountOccurrences(resumed, "--resume"));
                Assert.StartsWith("claude", resumed);
            });
        }

        [Fact]
        public void Uppercase_id_is_normalised_to_lowercase()
        {
            WithTempDir(dir =>
            {
                string resumed = LaunchCommandBuilder.BuildClaudeCommand(null, dir, Id.ToUpperInvariant()).AutoRunCommand;

                Assert.Contains($" --resume {Id}{Skip}", resumed);
                Assert.DoesNotContain(Id.ToUpperInvariant(), resumed);
            });
        }

        [Theory]
        [InlineData("{0f8fad5b-d9cb-469f-a165-70867728950e}")] // braced: "D" refuses it
        [InlineData("0f8fad5bd9cb469fa16570867728950e")]       // hyphenless "N" form
        [InlineData("x; rm")]
        [InlineData("0f8fad5b-d9cb-469f-a165-70867728950e; Remove-Item -Recurse ~")] // valid GUID prefix + payload
        [InlineData("0f8fad5b-d9cb-469f-a165-70867728950e --dangerously-load-anything")]
        [InlineData("not-a-guid")]
        public void Non_canonical_or_hostile_id_throws(string badId)
        {
            Assert.Throws<ArgumentException>(() => LaunchCommandBuilder.NormalizeResumeSessionId(badId));
            Assert.Throws<ArgumentException>(() => LaunchCommandBuilder.BuildClaudeCommand(null, Path.GetTempPath(), badId));
            Assert.Throws<ArgumentException>(() => LaunchCommandBuilder.BuildCommand(TerminalKind.ClaudeCode, null, Path.GetTempPath(), badId));
        }

        [Fact]
        public void BuildCommand_threads_the_id_to_the_claude_builder()
        {
            WithTempDir(dir =>
            {
                string resumed = LaunchCommandBuilder.BuildCommand(TerminalKind.ClaudeCode, null, dir, Id).AutoRunCommand;

                Assert.Contains($" --resume {Id}{Skip}", resumed);
            });
        }

        [Fact]
        public void Codex_with_an_id_throws_instead_of_dropping_it()
        {
            Assert.Throws<ArgumentException>(() =>
                LaunchCommandBuilder.BuildCommand(TerminalKind.Codex, null, Path.GetTempPath(), Id));
        }

        [Fact]
        public void Session_name_is_still_spliced_after_the_claude_token()
        {
            // ConPtyTerminal.ApplySessionName inserts -n right after the leading `claude` token and
            // gives up when the command does not start with it. A resumed launch must keep both.
            WithTempDir(dir =>
            {
                string resumed = LaunchCommandBuilder.BuildClaudeCommand(null, dir, Id).AutoRunCommand;

                string named = ConPtyTerminal.ApplySessionName(resumed, "Alice");

                Assert.StartsWith("claude -n 'Alice'", named);
                Assert.Contains($" --resume {Id}{Skip}", named);
                Assert.Equal(1, CountOccurrences(named, "--resume"));
            });
        }

        [Theory]
        // Plain "claude" adds nothing, so the user's own permissions.defaultMode applies (task 452d33a4).
        [InlineData("claude", "", "")]
        [InlineData("  Claude.exe  ", "", "")]
        [InlineData("claude --dangerously-skip-permissions", " --dangerously-skip-permissions", "")]
        [InlineData("claude --permission-mode auto", " --permission-mode auto", "")]
        // MT chooses the session on every launch: -c could attach a helper to its PM's live session.
        [InlineData("claude -c", "", "-c")]
        [InlineData("claude --continue --permission-mode auto", " --permission-mode auto", "--continue")]
        [InlineData("claude -r 0f8fad5b-d9cb-469f-a165-70867728950e --verbose", " --verbose", "-r 0f8fad5b-d9cb-469f-a165-70867728950e")]
        [InlineData("claude --resume --verbose", " --verbose", "--resume")]
        [InlineData("claude --session-id=abc --name=Bob -n Eve", "", "--session-id=abc --name=Bob -n Eve")]
        [InlineData("claude -nBob -r1234 --verbose", " --verbose", "-nBob -r1234")]
        // The tail lands unquoted in PowerShell -Command: one unsafe token drops the whole tail, so
        // no second statement runs and no quoted value is passed in pieces.
        [InlineData("claude --append-system-prompt \"hi there\" --verbose", "", "--append-system-prompt \"hi there\" --verbose")]
        [InlineData("claude --verbose ; calc", "", "--verbose ; calc")]
        [InlineData("claude --model opus;calc", "", "--model opus;calc")]
        [InlineData("claude --verbose @args", "", "--verbose @args")]
        [InlineData("claude --add-dir C:/x,D:/y --model user@host", " --add-dir C:/x,D:/y --model user@host", "")]
        // Something ticked that is not claude: no flag rather than silently picking bypass.
        [InlineData("npx claude", "", "npx claude")]
        // Nothing ticked (or no saved list): MT's previous behaviour.
        [InlineData(null, " --dangerously-skip-permissions", "")]
        [InlineData("   ", " --dangerously-skip-permissions", "")]
        public void Ticked_command_becomes_the_launch_arguments(string ticked, string expected, string expectedIgnored)
        {
            var ignored = new System.Collections.Generic.List<string>();

            Assert.Equal(expected, LaunchCommandBuilder.ClaudeLaunchArgs(ticked, ignored));
            Assert.Equal(expectedIgnored, string.Join(" ", ignored));
        }

        [Fact]
        public void An_untouched_command_list_still_bypasses_after_the_settings_dialog_saves_it()
        {
            // The Settings dialog loads the built-in list and saves it back on any OK, so whatever the
            // built-in list ticks becomes a fresh install's launch mode. (Lists saved before 452d33a4
            // are not covered: they hold the old built-in, plain claude ticked.)
            WithTempDir(dir =>
            {
                var settings = new SettingsService(dir);
                Assert.Equal(LaunchCommandBuilder.BypassPermissionsArgs,
                    LaunchCommandBuilder.ClaudeLaunchArgs(settings.GetDefaultClaudeCommand()?.Command));

                settings.SetClaudeCommands(settings.GetClaudeCommands());

                Assert.Equal(LaunchCommandBuilder.BypassPermissionsArgs,
                    LaunchCommandBuilder.ClaudeLaunchArgs(new SettingsService(dir).GetDefaultClaudeCommand()?.Command));
            });
        }

        private static int CountOccurrences(string haystack, string needle)
        {
            int count = 0;
            for (int i = haystack.IndexOf(needle, StringComparison.Ordinal); i >= 0;
                 i = haystack.IndexOf(needle, i + needle.Length, StringComparison.Ordinal))
                count++;
            return count;
        }

        private static void WithTempDir(Action<string> body)
        {
            string dir = Path.Combine(Path.GetTempPath(), "mt-launch-resume-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            try
            {
                body(dir);
            }
            finally
            {
                Directory.Delete(dir, recursive: true);
            }
        }
    }
}
