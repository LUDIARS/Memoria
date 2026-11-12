#include "shutdown_signal.hpp"

#include <csignal>

namespace memoria::owntracks {

namespace {

volatile std::sig_atomic_t g_signal = 0;

void on_shutdown_signal(int sig) {
	g_signal = sig;
}

}

void install_shutdown_signals() {
	std::signal(SIGINT, on_shutdown_signal);
	std::signal(SIGTERM, on_shutdown_signal);
}

int pending_shutdown_signal() {
	return static_cast<int>(g_signal);
}

const char* shutdown_signal_name(int sig) {
	if (sig == SIGINT) return "SIGINT";
	if (sig == SIGTERM) return "SIGTERM";
	return "signal";
}

}
