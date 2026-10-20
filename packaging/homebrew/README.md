# Homebrew CLI submission

`worldmonitor.rb` packages the published npm CLI 0.2.0, including its terminal dashboard.

The formula is prepared for submission to `Homebrew/homebrew-core`. Installation with `brew install worldmonitor` requires acceptance by Homebrew. Check the upstream submission before advertising that command.

To verify the formula in a local test tap, run:

```sh
brew tap-new worldmonitor/distribution-test
cp packaging/homebrew/worldmonitor.rb "$(brew --repository worldmonitor/distribution-test)/Formula/"
brew install --build-from-source worldmonitor/distribution-test/worldmonitor
brew test worldmonitor/distribution-test/worldmonitor
brew audit --strict --online worldmonitor/distribution-test/worldmonitor
brew style worldmonitor/distribution-test/worldmonitor
```

The formula test checks both command aliases and calls the real anonymous `get_sources` API without an API key. CLI 0.2.0 applies its 15-second timeout until response headers arrive. Homebrew's five-minute deadline bounds the complete test, including response-body reads. API errors, timeouts, and invalid responses fail the test. Network access is allowed during testing and denied during build and post-install.

After a CLI release reaches npm, use the exact registry archive URL and calculate its SHA-256 checksum. Update the formula in Homebrew through a version PR. Keep this submission copy synchronized until the initial Homebrew PR is accepted. After acceptance, the Homebrew formula is authoritative.
