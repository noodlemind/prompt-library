#define _GNU_SOURCE 1

#include <arpa/inet.h>
#include <errno.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

#if defined(__linux__)
#include <fcntl.h>
#include <linux/capability.h>
#include <poll.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#endif

#define MAX_PROVIDER_DESTINATIONS 32U
#define MAX_ARGUMENTS (5U + (MAX_PROVIDER_DESTINATIONS * 2U))
#define MAX_ARGUMENT_BYTES 8192U
#define MAX_SINGLE_ARGUMENT_BYTES 128U
#define MAX_START_TICKS_BYTES 31U
#define MAX_OUTPUT_BYTES 16384U
#define MAX_ENVIRONMENT_ENTRIES 4096U
#define MAX_ENVIRONMENT_NAME_BYTES 256U
#define CONNECT_TIMEOUT_MS 1000

#define PRIVATE_DAEMON_SOCKET "/run/engineer/private-docker.sock"
#define REAL_DAEMON_SOCKET "/var/run/docker.sock"
#define ALTERNATE_DAEMON_SOCKET "/run/docker.sock"
#define MOUNT_CANARY_TARGET "/engineer-bounded/.readiness-denial-mount"

enum exit_code {
  EXIT_INVALID_INVOCATION = 64,
  EXIT_INVALID_PLATFORM = 65,
  EXIT_OBSERVATION_FAILURE = 66,
  EXIT_DENIAL_FAILURE = 67
};

static const char MESSAGE_INVALID_INVOCATION[] =
  "engineer-readiness-denial-probe: invalid invocation\n";
static const char MESSAGE_INVALID_PLATFORM[] =
  "engineer-readiness-denial-probe: Linux runner required\n";
#if defined(__linux__)
static const char MESSAGE_OBSERVATION_FAILURE[] =
  "engineer-readiness-denial-probe: observation failed\n";
static const char MESSAGE_DENIAL_FAILURE[] =
  "engineer-readiness-denial-probe: denial failed\n";
#endif

struct provider_destination {
  int family;
  struct sockaddr_storage address;
  socklen_t length;
};

struct invocation {
  uint32_t target_pid;
  char target_start_ticks[MAX_START_TICKS_BYTES + 1U];
  struct provider_destination providers[MAX_PROVIDER_DESTINATIONS];
  size_t provider_count;
};

static _Noreturn void fatal(int code, const char *message) {
  const char *cursor = message;
  size_t remaining = strlen(message);
  while (remaining > 0U) {
    ssize_t written = write(STDERR_FILENO, cursor, remaining);
    if (written > 0) {
      cursor += (size_t)written;
      remaining -= (size_t)written;
    } else if (written < 0 && errno == EINTR) {
      continue;
    } else {
      break;
    }
  }
  _exit(code);
}

static int bounded_arguments(int argc, char **argv) {
  size_t total = 0U;
  int index;
  if (argc < 1 || argv == NULL || (unsigned int)argc > MAX_ARGUMENTS) return 0;
  for (index = 0; index < argc; index += 1) {
    size_t length;
    if (argv[index] == NULL) return 0;
    length = strnlen(argv[index], MAX_SINGLE_ARGUMENT_BYTES + 1U);
    if (length > MAX_SINGLE_ARGUMENT_BYTES
        || total > MAX_ARGUMENT_BYTES - length - 1U) return 0;
    total += length + 1U;
  }
  return total <= MAX_ARGUMENT_BYTES;
}

static int parse_uint32(const char *text, uint32_t minimum, uint32_t maximum,
    uint32_t *output) {
  uint64_t value = 0U;
  size_t index;
  size_t length;
  if (text == NULL || output == NULL) return 0;
  length = strnlen(text, 11U);
  if (length == 0U || length > 10U || (length > 1U && text[0] == '0')) return 0;
  for (index = 0U; index < length; index += 1U) {
    unsigned char character = (unsigned char)text[index];
    if (character < (unsigned char)'0' || character > (unsigned char)'9') return 0;
    value = (value * 10U) + (uint64_t)(character - (unsigned char)'0');
    if (value > (uint64_t)maximum) return 0;
  }
  if (value < (uint64_t)minimum) return 0;
  *output = (uint32_t)value;
  return 1;
}

static int parse_start_ticks(const char *text, char *output) {
  size_t length;
  size_t index;
  if (text == NULL || output == NULL) return 0;
  length = strnlen(text, MAX_START_TICKS_BYTES + 1U);
  if (length == 0U || length > MAX_START_TICKS_BYTES
      || (length > 1U && text[0] == '0')) return 0;
  for (index = 0U; index < length; index += 1U) {
    if (text[index] < '0' || text[index] > '9') return 0;
  }
  memcpy(output, text, length + 1U);
  return 1;
}

static int parse_provider(const char *flag, const char *text,
    struct provider_destination *destination) {
  if (flag == NULL || text == NULL || destination == NULL) return 0;
  memset(destination, 0, sizeof(*destination));
  if (strcmp(flag, "--provider-v4") == 0) {
    struct sockaddr_in *address = (struct sockaddr_in *)&destination->address;
    address->sin_family = AF_INET;
    address->sin_port = htons(443U);
    if (inet_pton(AF_INET, text, &address->sin_addr) != 1) return 0;
    destination->family = AF_INET;
    destination->length = (socklen_t)sizeof(*address);
    return 1;
  }
  if (strcmp(flag, "--provider-v6") == 0) {
    struct sockaddr_in6 *address = (struct sockaddr_in6 *)&destination->address;
    address->sin6_family = AF_INET6;
    address->sin6_port = htons(443U);
    if (strchr(text, '%') != NULL || inet_pton(AF_INET6, text, &address->sin6_addr) != 1) {
      return 0;
    }
    destination->family = AF_INET6;
    destination->length = (socklen_t)sizeof(*address);
    return 1;
  }
  return 0;
}

static int same_destination(const struct provider_destination *left,
    const struct provider_destination *right) {
  if (left->family != right->family) return 0;
  if (left->family == AF_INET) {
    const struct sockaddr_in *left_address = (const struct sockaddr_in *)&left->address;
    const struct sockaddr_in *right_address = (const struct sockaddr_in *)&right->address;
    return memcmp(&left_address->sin_addr, &right_address->sin_addr,
      sizeof(left_address->sin_addr)) == 0;
  }
  {
    const struct sockaddr_in6 *left_address = (const struct sockaddr_in6 *)&left->address;
    const struct sockaddr_in6 *right_address = (const struct sockaddr_in6 *)&right->address;
    return memcmp(&left_address->sin6_addr, &right_address->sin6_addr,
      sizeof(left_address->sin6_addr)) == 0;
  }
}

static int parse_invocation(int argc, char **argv, struct invocation *result) {
  int index = 1;
  if (result == NULL || !bounded_arguments(argc, argv)) return 0;
  memset(result, 0, sizeof(*result));
  if (index >= argc || strcmp(argv[index], "--target-pid") != 0) return 0;
  index += 1;
  if (index >= argc || !parse_uint32(argv[index], 1U, 4194304U, &result->target_pid)) {
    return 0;
  }
  index += 1;
  if (index >= argc || strcmp(argv[index], "--target-start-ticks") != 0) return 0;
  index += 1;
  if (index >= argc || !parse_start_ticks(argv[index], result->target_start_ticks)) return 0;
  index += 1;
  while (index < argc) {
    size_t prior;
    if (index + 1 >= argc || result->provider_count >= MAX_PROVIDER_DESTINATIONS) return 0;
    if (!parse_provider(argv[index], argv[index + 1],
        &result->providers[result->provider_count])) return 0;
    for (prior = 0U; prior < result->provider_count; prior += 1U) {
      if (same_destination(&result->providers[prior],
          &result->providers[result->provider_count])) return 0;
    }
    result->provider_count += 1U;
    index += 2;
  }
  return result->provider_count > 0U;
}

#if defined(__linux__)

extern char **environ;

enum unix_result {
  UNIX_RESULT_ABSENT = 1,
  UNIX_RESULT_DENIED = 2
};

struct output_buffer {
  char bytes[MAX_OUTPUT_BYTES];
  size_t length;
};

static int append_text(struct output_buffer *output, const char *format, ...) {
  va_list arguments;
  int count;
  size_t remaining;
  if (output == NULL || output->length >= sizeof(output->bytes)) return 0;
  remaining = sizeof(output->bytes) - output->length;
  va_start(arguments, format);
  count = vsnprintf(output->bytes + output->length, remaining, format, arguments);
  va_end(arguments);
  if (count < 0 || (size_t)count >= remaining) return 0;
  output->length += (size_t)count;
  return 1;
}

static int denied_errno(int value) {
  return value == EPERM || value == EACCES || value == ECONNREFUSED;
}

static int observe_identity(uint64_t *effective_capabilities) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  int group_count;
  if (effective_capabilities == NULL || getuid() != 2001U || geteuid() != 2001U
      || getgid() != 2001U || getegid() != 2001U) return 0;
  group_count = getgroups(0, NULL);
  if (group_count != 0) return 0;
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  header.pid = 0;
  if (syscall(SYS_capget, &header, data) != 0) return 0;
  *effective_capabilities = ((uint64_t)data[1].effective << 32U)
    | (uint64_t)data[0].effective;
  return *effective_capabilities == 0U
    && prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL) == 1;
}

static int active_mount_denial(int *observed_errno) {
  int result;
  if (observed_errno == NULL) return 0;
  errno = 0;
  result = mount("none", MOUNT_CANARY_TARGET, "tmpfs",
    MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4096");
  if (result == 0) {
    (void)umount2(MOUNT_CANARY_TARGET, MNT_DETACH);
    return -1;
  }
  *observed_errno = errno;
  return errno == EPERM || errno == EACCES ? 1 : 0;
}

static int active_ptrace_denial(pid_t target, int *observed_errno) {
  long result;
  if (observed_errno == NULL) return 0;
  errno = 0;
  result = ptrace(PTRACE_ATTACH, target, NULL, NULL);
  if (result == 0) {
    int status = 0;
    (void)waitpid(target, &status, 0);
    (void)ptrace(PTRACE_DETACH, target, NULL, NULL);
    return -1;
  }
  *observed_errno = errno;
  return errno == EPERM || errno == EACCES ? 1 : 0;
}

static int unix_socket_result(const char *socket_path, int require_denied,
    enum unix_result *output) {
  struct stat metadata;
  struct sockaddr_un address;
  int descriptor;
  int result;
  int saved_errno;
  size_t length;
  if (socket_path == NULL || output == NULL) return 0;
  if (lstat(socket_path, &metadata) != 0) {
    if (errno == ENOENT && !require_denied) {
      *output = UNIX_RESULT_ABSENT;
      return 1;
    }
    return 0;
  }
  if (!S_ISSOCK(metadata.st_mode)) return 0;
  length = strlen(socket_path);
  if (length == 0U || length >= sizeof(address.sun_path)) return 0;
  descriptor = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor < 0) return 0;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  memcpy(address.sun_path, socket_path, length + 1U);
  errno = 0;
  result = connect(descriptor, (const struct sockaddr *)&address,
    (socklen_t)sizeof(address));
  saved_errno = errno;
  (void)close(descriptor);
  if (result == 0) return -1;
  if (!denied_errno(saved_errno)) return 0;
  *output = UNIX_RESULT_DENIED;
  return 1;
}

static int tcp_denial(const struct sockaddr *address, socklen_t length, int family) {
  struct pollfd polling;
  int descriptor;
  int flags;
  int result;
  int socket_error;
  socklen_t error_length = (socklen_t)sizeof(socket_error);
  descriptor = socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (descriptor < 0) return 0;
  flags = fcntl(descriptor, F_GETFL, 0);
  if (flags < 0 || fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) != 0) {
    (void)close(descriptor);
    return 0;
  }
  errno = 0;
  result = connect(descriptor, address, length);
  if (result == 0) {
    (void)close(descriptor);
    return -1;
  }
  socket_error = errno;
  if (socket_error == EINPROGRESS) {
    memset(&polling, 0, sizeof(polling));
    polling.fd = descriptor;
    polling.events = POLLOUT;
    do {
      result = poll(&polling, 1U, CONNECT_TIMEOUT_MS);
    } while (result < 0 && errno == EINTR);
    if (result <= 0 || getsockopt(descriptor, SOL_SOCKET, SO_ERROR,
        &socket_error, &error_length) != 0) {
      (void)close(descriptor);
      return 0;
    }
  }
  (void)close(descriptor);
  if (socket_error == 0) return -1;
  return denied_errno(socket_error) ? 1 : 0;
}

static int metadata_denials(void) {
  static const char *addresses[] = { "169.254.169.254", "100.100.100.200" };
  size_t index;
  for (index = 0U; index < sizeof(addresses) / sizeof(addresses[0]); index += 1U) {
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_family = AF_INET;
    address.sin_port = htons(80U);
    if (inet_pton(AF_INET, addresses[index], &address.sin_addr) != 1
        || tcp_denial((const struct sockaddr *)&address,
          (socklen_t)sizeof(address), AF_INET) != 1) return 0;
  }
  return 1;
}

static unsigned char ascii_upper(unsigned char value) {
  return value >= (unsigned char)'a' && value <= (unsigned char)'z'
    ? (unsigned char)(value - (unsigned char)'a' + (unsigned char)'A')
    : value;
}

static int name_contains(const char *name, size_t name_length, const char *needle) {
  size_t needle_length = strlen(needle);
  size_t offset;
  if (needle_length == 0U || needle_length > name_length) return 0;
  for (offset = 0U; offset <= name_length - needle_length; offset += 1U) {
    size_t index;
    for (index = 0U; index < needle_length; index += 1U) {
      if (ascii_upper((unsigned char)name[offset + index])
          != (unsigned char)needle[index]) break;
    }
    if (index == needle_length) return 1;
  }
  return 0;
}

static int environment_names_exclude(const char *const *forbidden,
    size_t forbidden_count) {
  size_t entry_index;
  if (environ == NULL || forbidden == NULL || forbidden_count == 0U) return 0;
  for (entry_index = 0U; environ[entry_index] != NULL; entry_index += 1U) {
    const char *separator;
    size_t name_length;
    size_t forbidden_index;
    if (entry_index >= MAX_ENVIRONMENT_ENTRIES) return 0;
    separator = strchr(environ[entry_index], '=');
    if (separator == NULL) return 0;
    name_length = (size_t)(separator - environ[entry_index]);
    if (name_length == 0U || name_length > MAX_ENVIRONMENT_NAME_BYTES) return 0;
    for (forbidden_index = 0U; forbidden_index < forbidden_count;
        forbidden_index += 1U) {
      if (name_contains(environ[entry_index], name_length, forbidden[forbidden_index])) {
        return 0;
      }
    }
  }
  return 1;
}

static int daytona_credential_names_absent(void) {
  static const char *forbidden[] = { "DAYTONA" };
  return environment_names_exclude(forbidden,
    sizeof(forbidden) / sizeof(forbidden[0]));
}

static int provider_credential_names_absent(void) {
  static const char *forbidden[] = {
    "OPENROUTER", "OPENAI", "ANTHROPIC", "GEMINI", "GOOGLE_AI", "GROQ",
    "XAI", "MISTRAL", "COHERE", "TOGETHER", "FIREWORKS", "DEEPSEEK",
    "CEREBRAS", "PERPLEXITY", "API_KEY", "AUTHORIZATION", "CREDENTIAL",
    "PASSWORD", "SECRET", "TOKEN"
  };
  return environment_names_exclude(forbidden,
    sizeof(forbidden) / sizeof(forbidden[0]));
}

static const char *unix_result_name(enum unix_result value) {
  return value == UNIX_RESULT_ABSENT ? "absent" : "denied";
}

static int write_observation(const struct invocation *input, int mount_errno,
    int ptrace_errno, enum unix_result private_socket, enum unix_result real_socket,
    enum unix_result alternate_socket, uint64_t effective_capabilities,
    int daytona_credentials_absent, int provider_credentials_absent) {
  struct output_buffer output;
  size_t offset = 0U;
  memset(&output, 0, sizeof(output));
  if (!append_text(&output,
      "{\"daytonaCredentialsAbsent\":%s,\"effectiveCapabilities\":%" PRIu64
      ",\"egress\":{\"denied\":true,\"metadataAttempts\":2,"
      "\"metadataConnected\":0,\"providerAttempts\":%zu,"
      "\"providerConnected\":0},\"gid\":2001,"
      "\"mount\":{\"denied\":true,\"errno\":%d},"
      "\"noNewPrivileges\":true,"
      "\"providerCredentialsAbsent\":%s,"
      "\"ptrace\":{\"denied\":true,\"errno\":%d,\"targetPid\":%" PRIu32
      ",\"targetStartTicks\":\"%s\"},"
      "\"schema\":\"engineer-readiness-denial-observation.v1\","
      "\"sockets\":{\"alternate\":\"%s\",\"private\":\"%s\","
      "\"real\":\"%s\"},\"supplementaryGroups\":[],\"uid\":2001}\n",
      daytona_credentials_absent ? "true" : "false", effective_capabilities,
      input->provider_count, mount_errno,
      provider_credentials_absent ? "true" : "false", ptrace_errno,
      input->target_pid, input->target_start_ticks,
      unix_result_name(alternate_socket), unix_result_name(private_socket),
      unix_result_name(real_socket))) return 0;
  while (offset < output.length) {
    ssize_t written = write(STDOUT_FILENO, output.bytes + offset, output.length - offset);
    if (written > 0) {
      offset += (size_t)written;
    } else if (written < 0 && errno == EINTR) {
      continue;
    } else {
      return 0;
    }
  }
  return 1;
}

static int run_probe(const struct invocation *input) {
  uint64_t effective_capabilities = UINT64_MAX;
  enum unix_result private_socket;
  enum unix_result real_socket;
  enum unix_result alternate_socket;
  int mount_errno = 0;
  int ptrace_errno = 0;
  int daytona_credentials_absent;
  int provider_credentials_absent;
  int result;
  size_t index;
  if (!observe_identity(&effective_capabilities)) {
    fatal(EXIT_INVALID_PLATFORM, MESSAGE_INVALID_PLATFORM);
  }
  result = active_mount_denial(&mount_errno);
  if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
  if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  result = active_ptrace_denial((pid_t)input->target_pid, &ptrace_errno);
  if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
  if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  result = unix_socket_result(PRIVATE_DAEMON_SOCKET, 1, &private_socket);
  if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
  if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  result = unix_socket_result(REAL_DAEMON_SOCKET, 0, &real_socket);
  if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
  if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  result = unix_socket_result(ALTERNATE_DAEMON_SOCKET, 0, &alternate_socket);
  if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
  if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  for (index = 0U; index < input->provider_count; index += 1U) {
    result = tcp_denial((const struct sockaddr *)&input->providers[index].address,
      input->providers[index].length, input->providers[index].family);
    if (result < 0) fatal(EXIT_DENIAL_FAILURE, MESSAGE_DENIAL_FAILURE);
    if (result == 0) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  }
  daytona_credentials_absent = daytona_credential_names_absent();
  provider_credentials_absent = provider_credential_names_absent();
  if (!metadata_denials() || !daytona_credentials_absent
      || !provider_credentials_absent) {
    fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  }
  return write_observation(input, mount_errno, ptrace_errno, private_socket,
    real_socket, alternate_socket, effective_capabilities,
    daytona_credentials_absent, provider_credentials_absent);
}

#endif

int main(int argc, char **argv) {
  struct invocation input;
  if (!parse_invocation(argc, argv, &input)) {
    fatal(EXIT_INVALID_INVOCATION, MESSAGE_INVALID_INVOCATION);
  }
#if !defined(__linux__)
  fatal(EXIT_INVALID_PLATFORM, MESSAGE_INVALID_PLATFORM);
#else
  if (!run_probe(&input)) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  return 0;
#endif
}
