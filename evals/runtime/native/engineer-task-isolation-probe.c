#define _GNU_SOURCE 1

#include <errno.h>
#include <inttypes.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/capability.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#endif

#define MAX_INTERFACES 64U
#define MAX_OUTPUT_BYTES 8192U

enum exit_code {
  EXIT_INVALID_INVOCATION = 64,
  EXIT_INVALID_PLATFORM = 65,
  EXIT_OBSERVATION_FAILURE = 66
};

static const char MESSAGE_INVALID_INVOCATION[] =
  "engineer-task-isolation-probe: invalid invocation\n";
#if !defined(__linux__)
static const char MESSAGE_INVALID_PLATFORM[] =
  "engineer-task-isolation-probe: Linux required\n";
#else
static const char MESSAGE_OBSERVATION_FAILURE[] =
  "engineer-task-isolation-probe: observation failed\n";
#endif

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

#if defined(__linux__)

struct interface_record {
  unsigned int index;
  char name[IF_NAMESIZE];
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

static int append_json_string(struct output_buffer *output, const char *value) {
  const unsigned char *cursor = (const unsigned char *)value;
  if (!append_text(output, "\"")) return 0;
  while (*cursor != 0U) {
    unsigned char character = *cursor;
    if (character == (unsigned char)'"' || character == (unsigned char)'\\') {
      if (!append_text(output, "\\%c", (int)character)) return 0;
    } else if (character >= 0x20U && character <= 0x7eU) {
      if (!append_text(output, "%c", (int)character)) return 0;
    } else {
      if (!append_text(output, "\\u%04x", (unsigned int)character)) return 0;
    }
    cursor += 1;
  }
  return append_text(output, "\"");
}

static int compare_interfaces(const void *left_value, const void *right_value) {
  const struct interface_record *left = (const struct interface_record *)left_value;
  const struct interface_record *right = (const struct interface_record *)right_value;
  if (left->index < right->index) return -1;
  if (left->index > right->index) return 1;
  return strcmp(left->name, right->name);
}

static int observe_interfaces(struct interface_record *records, size_t *record_count) {
  struct if_nameindex *inventory;
  size_t count = 0U;

  if (records == NULL || record_count == NULL) return 0;
  inventory = if_nameindex();
  if (inventory == NULL) return 0;
  while (inventory[count].if_index != 0U || inventory[count].if_name != NULL) {
    size_t length;
    if (inventory[count].if_index == 0U || inventory[count].if_name == NULL
        || count >= MAX_INTERFACES) {
      if_freenameindex(inventory);
      return 0;
    }
    length = strnlen(inventory[count].if_name, IF_NAMESIZE);
    if (length == 0U || length >= IF_NAMESIZE) {
      if_freenameindex(inventory);
      return 0;
    }
    records[count].index = inventory[count].if_index;
    memcpy(records[count].name, inventory[count].if_name, length + 1U);
    count += 1U;
  }
  if_freenameindex(inventory);
  if (count == 0U) return 0;
  qsort(records, count, sizeof(records[0]), compare_interfaces);
  for (size_t index = 1U; index < count; index += 1U) {
    if (records[index - 1U].index == records[index].index
        || strcmp(records[index - 1U].name, records[index].name) == 0) return 0;
  }
  *record_count = count;
  return 1;
}

static int observe_capability_mask(uint64_t *effective) {
  struct __user_cap_header_struct header;
  struct __user_cap_data_struct data[2];
  if (effective == NULL) return 0;
  memset(&header, 0, sizeof(header));
  memset(data, 0, sizeof(data));
  header.version = _LINUX_CAPABILITY_VERSION_3;
  header.pid = 0;
  if (syscall(SYS_capget, &header, data) != 0) return 0;
  *effective = ((uint64_t)data[1].effective << 32U) | (uint64_t)data[0].effective;
  return 1;
}

static int write_observation(void) {
  struct stat network_namespace;
  struct stat mount_namespace;
  struct interface_record interfaces[MAX_INTERFACES];
  struct output_buffer output;
  uint64_t effective_capabilities;
  size_t interface_count = 0U;
  int no_new_privileges;
  int raw_socket;
  int raw_socket_denied = 0;
  size_t offset = 0U;

  memset(&output, 0, sizeof(output));
  memset(interfaces, 0, sizeof(interfaces));
  if (stat("/proc/self/ns/net", &network_namespace) != 0
      || stat("/proc/self/ns/mnt", &mount_namespace) != 0
      || !observe_interfaces(interfaces, &interface_count)
      || !observe_capability_mask(&effective_capabilities)) return 0;
  no_new_privileges = prctl(PR_GET_NO_NEW_PRIVS, 0UL, 0UL, 0UL, 0UL);
  if (no_new_privileges != 0 && no_new_privileges != 1) return 0;

  raw_socket = socket(AF_INET, SOCK_RAW | SOCK_CLOEXEC, IPPROTO_ICMP);
  if (raw_socket >= 0) {
    if (close(raw_socket) != 0) return 0;
  } else {
    int socket_error = errno;
    raw_socket_denied = socket_error == EPERM || socket_error == EACCES;
  }
  if (effective_capabilities > UINT64_C(9007199254740991)) return 0;

  if (!append_text(&output,
      "{\"schema\":\"engineer-task-isolation-observation.v1\","
      "\"networkNamespaceIdentity\":\"dev:%ju:ino:%ju\","
      "\"mountNamespaceIdentity\":\"dev:%ju:ino:%ju\","
      "\"interfaceInventory\":[",
      (uintmax_t)network_namespace.st_dev, (uintmax_t)network_namespace.st_ino,
      (uintmax_t)mount_namespace.st_dev, (uintmax_t)mount_namespace.st_ino)) return 0;
  for (size_t index = 0U; index < interface_count; index += 1U) {
    char identity[IF_NAMESIZE + 32U];
    int identity_length;
    if (index > 0U && !append_text(&output, ",")) return 0;
    identity_length = snprintf(identity, sizeof(identity), "%u:%s",
      interfaces[index].index, interfaces[index].name);
    if (identity_length < 1 || (size_t)identity_length >= sizeof(identity)
        || !append_json_string(&output, identity)) return 0;
    memset(identity, 0, sizeof(identity));
  }
  if (!append_text(&output,
      "],\"effectiveCapabilities\":%" PRIu64 ","
      "\"noNewPrivileges\":%s,\"rawSocketDenied\":%s}\n",
      effective_capabilities,
      no_new_privileges == 1 ? "true" : "false",
      raw_socket_denied != 0 ? "true" : "false")) return 0;

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

#endif

int main(int argc, char **argv) {
  if (argc != 1 || argv == NULL || argv[0] == NULL) {
    fatal(EXIT_INVALID_INVOCATION, MESSAGE_INVALID_INVOCATION);
  }
#if !defined(__linux__)
  fatal(EXIT_INVALID_PLATFORM, MESSAGE_INVALID_PLATFORM);
#else
  if (!write_observation()) fatal(EXIT_OBSERVATION_FAILURE, MESSAGE_OBSERVATION_FAILURE);
  return 0;
#endif
}
