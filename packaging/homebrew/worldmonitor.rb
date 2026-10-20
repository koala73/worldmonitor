class Worldmonitor < Formula
  desc "Command-line client for the World Monitor global intelligence API"
  homepage "https://worldmonitor.app/docs/cli"
  url "https://registry.npmjs.org/worldmonitor/-/worldmonitor-0.2.0.tgz"
  sha256 "984cfdba6390e71940c6de457eb44c433c94b5a621df3e48342d806053b3f723"
  license "MIT"

  depends_on "node"

  allow_network_access! :test

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/worldmonitor --version")
    assert_match version.to_s, shell_output("#{bin}/wm --version")

    output = shell_output("#{bin}/worldmonitor call get_sources --view summary --timeout 15000")
    result = JSON.parse(output).fetch("structuredContent")
    assert_equal "summary", result.fetch("view")
    assert_operator result.fetch("summary").fetch("providerCount"), :>, 0
  end
end
