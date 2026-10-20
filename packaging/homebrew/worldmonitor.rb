class Worldmonitor < Formula
  desc "Command-line client for the World Monitor global intelligence API"
  homepage "https://worldmonitor.app/docs/cli"
  url "https://registry.npmjs.org/worldmonitor/-/worldmonitor-0.2.0.tgz"
  sha256 "984cfdba6390e71940c6de457eb44c433c94b5a621df3e48342d806053b3f723"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink libexec.glob("bin/*")
  end

  test do
    require "socket"

    assert_match version.to_s, shell_output("#{bin}/worldmonitor --version")
    assert_match version.to_s, shell_output("#{bin}/wm --version")

    server = TCPServer.new("127.0.0.1", 0)
    port = server.addr[1]
    worker = Thread.new do
      socket = server.accept
      path = socket.gets.split[1]
      socket.each_line do |line|
        break if line == "\r\n"
      end
      body = JSON.generate({ "path" => path })
      headers = ["HTTP/1.1 200 OK", "Content-Type: application/json",
                 "Content-Length: #{body.bytesize}", "Connection: close", "", ""].join("\r\n")
      socket.write headers + body
      socket.close
    end

    output = shell_output("#{bin}/worldmonitor get /api/example --limit 3 --base-url http://127.0.0.1:#{port}")
    assert_equal "/api/example?limit=3", JSON.parse(output).fetch("path")
  ensure
    worker&.kill
    server&.close
  end
end
